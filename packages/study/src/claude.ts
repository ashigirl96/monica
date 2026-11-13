import { type ChildProcessByStdio, spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import type {
  Options,
  query as sdkQuery,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { localIso } from '@monica/ui/local-time'

import { type AskUser, tutorBox } from './box.ts'
import type { Choice, Model } from './contract.ts'
import { playgroundEnv } from './playground.ts'
import reflectionRequest from './reflection.md' with { type: 'text' }

export type Query = typeof sdkQuery

// 1 つ 270〜290MB あるので、同時に持つ claude はここまで。
const MAX_CLAUDES = 4
const BASH_COMMAND_CHARS = 200
// claude は resume の session が無いと、この文を stderr に出して exit 1 する。
const NO_SDK_RECORD = 'No conversation found with session ID'
const STDERR_TAIL_CHARS = 2000
// claude の子が stderr の pipe を握ったままでも、turn の失敗を出すのを待たせない。
const STDERR_CLOSE_WAIT_MS = 200

// Backend の env は Monica を起こした shell しだいで、認証・接続先・effort を替える key が届くので、通す key だけで組む。
const PASSED_ENV_KEYS = ['USER', 'HOME']
const ADDED_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_MAX_RETRIES: '4',
}

/** 起こした claude の process。turn の帳簿は持たない。 */
type Process = {
  messages: AsyncIterator<SDKMessage>
  say(text: string): void
  /** 走っている turn を止める。止めた turn も result で閉じる。 */
  interrupt(): Promise<void>
  stderrTail(): Promise<string>
  kill(): void
  /** process が居なくなると解ける。起こす前なら解けている。 */
  exited(): Promise<void>
  /** 次の turn を choice の model と effort で答えさせる。今と同じなら何もしない。 */
  choose(choice: Choice): Promise<void>
}

type ProcessDeps = {
  home: string
  tutorDir: string
  learningPreferenceDir: string
  claudePath: string | undefined
  query: Query
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export const envFileOf = (home: string, studyId: string) => join(home, 'study-env', `${studyId}.sh`)

// 箱の外でも走ってよい、Tutor が書ける file を読ませない名前だけの変数。docker の label と compose の project に要る。
const NAME_ONLY_KEYS = ['MONICA_STUDY_DIR', 'MONICA_STUDY_ID', 'COMPOSE_PROJECT_NAME']

// claude は CLAUDE_ENV_FILE を読み、Bash の command ごとに先に流す。箱の外の command では流す中身も箱の外で走るので、
// Tutor が書ける env/ の下を指す変数と env/env.sh は、claude が箱の中の command にだけ付ける SANDBOX_RUNTIME=1 の時に限って使う。
// file は Tutor が書き換えられないよう、Study の dir の外に置く。
function writeEnvFile(home: string, study: { id: string; dir: string }): string {
  const path = envFileOf(home, study.id)
  const envSh = quote(join(study.dir, 'env', 'env.sh'))
  const playground = playgroundEnv(study.dir, study.id)
  const exports = (keys: string[], indent: string) =>
    keys.map((key) => `${indent}export ${key}=${quote(playground[key]!)}\n`).join('')
  const toolKeys = Object.keys(playground).filter((key) => !NAME_ONLY_KEYS.includes(key))
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // symlink を辿って他の file を上書きしないよう、消してから新しく作る。
  rmSync(path, { force: true })
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants
  const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    writeSync(
      fd,
      `${exports(NAME_ONLY_KEYS, '')}if [ "\${SANDBOX_RUNTIME:-}" = 1 ]; then\n  export HOME=${quote(join(study.dir, 'env', 'home'))}\n${exports(toolKeys, '  ')}  if [ -f ${envSh} ]; then . ${envSh}; fi\nfi\n`,
    )
  } finally {
    closeSync(fd)
  }
  return path
}

// 箱は HOME の下の読みを断るので、そこにある dir は Bash で exit 126 になり、無いと分からずに迷う。
function pathOutsideHome(): string {
  const home = homedir()
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '' && dir !== home && !dir.startsWith(`${home}/`))
    .join(':')
}

function claudeEnv(envFile?: string): { [key: string]: string } {
  const env: { [key: string]: string } = {
    ...ADDED_ENV,
    PATH: pathOutsideHome(),
    ...(envFile && { CLAUDE_ENV_FILE: envFile }),
  }
  for (const key of PASSED_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function inbox() {
  const queued: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  return {
    push(message: SDKUserMessage) {
      queued.push(message)
      wake?.()
      wake = null
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const next = queued.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

/** 同期に claude を起こす。SDK は query() の中で同期に spawn するので、起こす数の勘定に await を挟まない。 */
function startClaude(
  deps: ProcessDeps,
  study: { id: string; dir: string; sessionId: string | null },
  choice: Choice,
  hooks: { askUser: AskUser; reflecting: () => boolean },
): Process {
  const teaching = readFileSync(join(deps.tutorDir, 'TEACHING.md'), 'utf8')
  const learningPreference = join(deps.learningPreferenceDir, 'LEARNING-PREFERENCE.md')
  const skills = readdirSync(join(deps.tutorDir, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `tutors:${entry.name}`)
  const envFile = writeEnvFile(deps.home, study)
  const box = tutorBox({
    studyDir: study.dir,
    tutorDir: deps.tutorDir,
    learningPreferenceDir: deps.learningPreferenceDir,
    monicaHome: deps.home,
    ...hooks,
  })

  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null
  let tail = ''
  let stderrClosed: Promise<void> = Promise.resolve()
  let exited: Promise<void> = Promise.resolve()
  const options: Options = {
    ...box,
    // 渡さないと CLI が最初の発言を丸ごと入れた title 生成の request を別に出す。
    title: study.id,
    systemPrompt: `${teaching}\nThe Learning Preference file is ${learningPreference}\n`,
    // resume は plugins を戻さないので、起こすたびに渡す。
    plugins: [{ type: 'local', path: deps.tutorDir, skipMcpDiscovery: true }],
    skills,
    settingSources: [],
    includePartialMessages: true,
    ...(choice.model && { model: choice.model }),
    ...(choice.effort && { effort: choice.effort }),
    ...(deps.claudePath && { pathToClaudeCodeExecutable: deps.claudePath }),
    ...(study.sessionId && { resume: study.sessionId }),
    env: { ...claudeEnv(envFile), ...box.env },
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      // detached にして group ごと止め、Tutor の Bash が起こした server も残さない。
      const spawned = spawn(command, args, {
        cwd,
        env,
        signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      child = spawned
      exited = new Promise((resolve) => spawned.once('exit', () => resolve()))
      stderrClosed = new Promise((resolve) => spawned.stderr.once('close', resolve))
      spawned.stderr.setEncoding('utf8')
      // 読まずに放った stderr の pipe は詰まって claude が止まる。
      spawned.stderr.on('data', (chunk: string) => {
        process.stderr.write(chunk)
        tail = (tail + chunk).slice(-STDERR_TAIL_CHARS)
      })
      return spawned
    },
  }
  const input = inbox()
  const messages = deps.query({ prompt: input, options })
  let chosen = choice

  return {
    messages,
    say(text) {
      input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      })
    },
    interrupt: async () => {
      await messages.interrupt()
    },
    async stderrTail() {
      await Promise.race([stderrClosed, Bun.sleep(STDERR_CLOSE_WAIT_MS)])
      return tail
    },
    kill() {
      const pid = child?.pid
      if (!pid) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    },
    exited: () => exited,
    async choose(next) {
      if (next.model !== chosen.model) await messages.setModel(next.model)
      // null は model の既定の effort に戻す。
      if (next.effort !== chosen.effort) {
        await messages.applyFlagSettings({ effortLevel: next.effort ?? null })
      }
      chosen = next
    },
  }
}

/** turn を答える Study Conversation。resume は claude を起こし直す時にだけ使う。 */
export type TutorConversation = { id: string; startedAt: Date; sessionId: string | null }

/** 1 つの turn で Tutor に頼むこと。振り返りは会話の claude の model と effort のまま、Read・Write・Edit だけで答える。 */
export type TutorRequest = { kind: 'say'; text: string; choice: Choice } | { kind: 'reflect' }

/** turn の中で起きたこと。SDK の型は越えない。 */
export type TutorEvent =
  /** 会話を resume するための session。何度も来る。 */
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  /** Tutor の文の 1 塊。 */
  | { type: 'tutor'; text: string }
  /** 結果が返った tool。text は何に使ったかの 1 行。 */
  | { type: 'tool'; tool: string; text: string }
  /** tutors:<name> の Skill を呼んで Tutor を替えた。前と同じかは見ない。 */
  | { type: 'tutor-switch'; tutor: string }

/** turn の終わり方。 */
export type TurnEnd =
  /** lastText は turn の最後の Tutor の文で、無ければ空。 */
  | { kind: 'answered'; lastText: string }
  /** result の error の文か、turn の途中で居なくなった claude の stderr の末尾。 */
  | { kind: 'failed'; error: string }
  /** resume した session の SDK の記録が無く、この会話は続けられない。 */
  | { kind: 'session-lost'; error: string }
  /** stop() の後に終わった turn。会話には何も決めない。 */
  | { kind: 'stopped'; error: string | null }

export type TutorClaudes = {
  /**
   * prepare の前に claude の席を同期に確かめ、空かなければ prepare を呼ばずに full を返す。
   * prepare は同期で、席を確かめた後に記録を書き、turn の会話と出来事の受け手を返す。throw すれば何も起こさずにそのまま投げる。
   * onEvent は turn の出来事を順に同期で受け、throw すると claude を止めて turn を失敗にする。
   */
  reply<T>(
    studyId: string,
    request: TutorRequest,
    prepare: () => {
      conversation: TutorConversation
      value: T
      onEvent: (event: TutorEvent) => void
    },
  ): { value: T; ended: Promise<TurnEnd> } | 'full'
  /** 走っている turn を止める。止めた turn も reply の ended で終わる。 */
  interrupt(studyId: string): Promise<void>
  /** Study の claude を止め、次の turn を新しい session で始めさせる。process が居なくなると解ける。 */
  close(studyId: string): Promise<void>
  /** すべての claude の group を同期に止める。以後の turn は claude を起こさずに stopped で終わる。 */
  stop(): void
}

type ToolUse = { name: string; input: Record<string, unknown> }

type Slot = {
  process: Process
  conversationId: string
  /** まだ発言を 1 つも流していない新しい session か。 */
  fresh: boolean
  answering: TutorRequest['kind'] | null
  lastTurnAt: number
  toolUses: Map<string, ToolUse>
}

export function createTutorClaudes(deps: {
  home: string
  tutorDir: string
  claudePath: string | undefined
  query: Query
  studyDir: (studyId: string) => string
  askUser: (studyId: string) => AskUser
}): TutorClaudes {
  const learningPreferenceDir = join(deps.home, 'learning-preference')
  // tutorBox が realpath を取るので、Learning Preference の file より先に dir を置く。
  mkdirSync(learningPreferenceDir, { recursive: true, mode: 0o700 })
  const processDeps: ProcessDeps = { ...deps, learningPreferenceDir }
  const slots = new Map<string, Slot>()
  let stopped = false

  function drop(studyId: string, slot: Slot) {
    if (slots.get(studyId) === slot) slots.delete(studyId)
    slot.process.kill()
  }

  function oldestIdle(): [string, Slot] | undefined {
    return [...slots]
      .filter(([, slot]) => slot.answering === null)
      .reduce<[string, Slot] | undefined>(
        (found, entry) => (!found || entry[1].lastTurnAt < found[1].lastTurnAt ? entry : found),
        undefined,
      )
  }

  function take(studyId: string, conversation: TutorConversation, choice: Choice): Slot {
    const held = slots.get(studyId)
    if (held?.conversationId === conversation.id) return held
    if (held) drop(studyId, held)
    const victim = slots.size >= MAX_CLAUDES ? oldestIdle() : undefined
    if (victim) drop(...victim)
    const process = startClaude(
      processDeps,
      { id: studyId, dir: deps.studyDir(studyId), sessionId: conversation.sessionId },
      choice,
      {
        askUser: deps.askUser(studyId),
        reflecting: () => slots.get(studyId)?.answering === 'reflect',
      },
    )
    const slot: Slot = {
      process,
      conversationId: conversation.id,
      fresh: !conversation.sessionId,
      answering: null,
      lastTurnAt: Date.now(),
      toolUses: new Map(),
    }
    slots.set(studyId, slot)
    void process.exited().then(() => {
      if (slots.get(studyId) === slot) slots.delete(studyId)
    })
    return slot
  }

  /** turn の終わりまで claude の message を読む。失敗なら result の文か stderr の末尾を返す。 */
  async function readTurn(studyId: string, slot: Slot, emit: (event: TutorEvent) => void) {
    for (;;) {
      let next: IteratorResult<SDKMessage>
      try {
        // for await を break すると iterator が閉じるので、turn ごとに result まで next() を呼ぶ。
        next = await slot.process.messages.next()
      } catch {
        next = { done: true, value: undefined }
      }
      if (next.done) {
        drop(studyId, slot)
        return (await slot.process.stderrTail()) || 'claude exited before the turn ended'
      }
      const message = next.value
      if (message.type === 'result') {
        if (!message.is_error) return null
        return message.subtype === 'success' ? message.result : message.errors.join('\n')
      }
      try {
        for (const event of eventsOf(slot.toolUses, message)) emit(event)
      } catch (error) {
        // 読み残した turn の続きを、次の turn に読ませない。
        drop(studyId, slot)
        throw error
      }
    }
  }

  async function run(
    studyId: string,
    conversation: TutorConversation,
    request: TutorRequest,
    onEvent: (event: TutorEvent) => void,
  ): Promise<TurnEnd> {
    let error: string | null
    let lastText = ''
    try {
      // 振り返りの turn は choice を持たないので、起こし直した claude は既定の model で答える。
      const slot = take(studyId, conversation, request.kind === 'say' ? request.choice : {})
      slot.answering = request.kind
      try {
        if (request.kind === 'say') await slot.process.choose(request.choice)
        slot.lastTurnAt = Date.now()
        const text = request.kind === 'say' ? request.text : reflectionRequest
        slot.process.say(
          slot.fresh
            ? `Study Conversation started at ${localIso(conversation.startedAt)}\n${text}`
            : text,
        )
        slot.fresh = false
        error = await readTurn(studyId, slot, (event) => {
          if (event.type === 'tutor') lastText = event.text
          onEvent(event)
        })
        slot.lastTurnAt = Date.now()
      } finally {
        slot.answering = null
      }
    } catch (thrown) {
      error = (thrown as Error).message
    }
    if (stopped) return { kind: 'stopped', error }
    if (error === null) return { kind: 'answered', lastText }
    return error.includes(NO_SDK_RECORD)
      ? { kind: 'session-lost', error }
      : { kind: 'failed', error }
  }

  return {
    reply(studyId, request, prepare) {
      const held = slots.get(studyId)
      if (held?.answering) throw new Error(`the Tutor of ${studyId} is already answering`)
      if (!stopped && !held && slots.size >= MAX_CLAUDES && !oldestIdle()) return 'full'
      const { conversation, value, onEvent } = prepare()
      if (stopped) {
        return {
          value,
          ended: Promise.resolve({ kind: 'stopped', error: 'the Backend is stopping' }),
        }
      }
      return { value, ended: run(studyId, conversation, request, onEvent) }
    },
    async interrupt(studyId) {
      try {
        await slots.get(studyId)?.process.interrupt()
      } catch {
        // claude が先に居なくなっても、turn は readTurn が閉じる。
      }
    },
    close(studyId) {
      const slot = slots.get(studyId)
      if (!slot) return Promise.resolve()
      drop(studyId, slot)
      return slot.process.exited()
    },
    stop() {
      stopped = true
      for (const slot of slots.values()) slot.process.kill()
      slots.clear()
    },
  }
}

function eventsOf(toolUses: Map<string, ToolUse>, message: SDKMessage): TutorEvent[] {
  if (message.type === 'system' && message.subtype === 'init') {
    return [{ type: 'session', sessionId: message.session_id }]
  }
  if (
    message.type === 'stream_event' &&
    message.event.type === 'content_block_delta' &&
    message.event.delta.type === 'text_delta'
  ) {
    return [{ type: 'delta', text: message.event.delta.text }]
  }
  if (message.type === 'assistant') {
    const events: TutorEvent[] = []
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text !== '') {
        events.push({ type: 'tutor', text: block.text })
      } else if (block.type === 'tool_use') {
        toolUses.set(block.id, {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        })
      }
    }
    return events
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    return message.message.content.flatMap((block) =>
      block.type === 'tool_result' ? toolEventOf(toolUses, block.tool_use_id) : [],
    )
  }
  return []
}

function toolEventOf(toolUses: Map<string, ToolUse>, toolUseId: string): TutorEvent[] {
  const use = toolUses.get(toolUseId)
  if (!use) return []
  toolUses.delete(toolUseId)
  const skill = use.input.skill
  if (use.name === 'Skill' && typeof skill === 'string' && skill.startsWith('tutors:')) {
    return [{ type: 'tutor-switch', tutor: skill.slice('tutors:'.length) }]
  }
  return [{ type: 'tool', tool: use.name, text: toolText(use.name, use.input) }]
}

function toolText(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => (typeof input[key] === 'string' ? input[key] : '')
  switch (name) {
    case 'Bash':
      return (field('command').split('\n')[0] ?? '').slice(0, BASH_COMMAND_CHARS)
    case 'Read':
    case 'Write':
    case 'Edit':
      return field('file_path')
    case 'Glob':
    case 'Grep':
      return field('pattern')
    case 'WebFetch':
      return field('url')
    case 'WebSearch':
      return field('query')
    default:
      return ''
  }
}

/** Tutor と同じ env の claude を起こして model の一覧を訊き、閉じる。 */
export async function readModels(
  deps: Pick<ProcessDeps, 'query' | 'claudePath'>,
): Promise<Model[]> {
  const { promise: ended, resolve: end } = Promise.withResolvers<void>()
  // 一覧を受けるまで claude の stdin を開けておく。
  const nothing: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => ended.then(() => ({ done: true, value: undefined })),
    }),
  }
  const q = deps.query({
    prompt: nothing,
    options: {
      settingSources: [],
      env: claudeEnv(),
      ...(deps.claudePath && { pathToClaudeCodeExecutable: deps.claudePath }),
    },
  })
  try {
    const found = await q.supportedModels()
    return found.map(
      ({ value, displayName, description, supportsEffort, supportedEffortLevels }) => ({
        value,
        displayName,
        description,
        ...(supportsEffort !== undefined && { supportsEffort }),
        ...(supportedEffortLevels && { supportedEffortLevels }),
      }),
    )
  } finally {
    end()
    q.close()
  }
}
