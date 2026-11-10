import { type ChildProcessByStdio, spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import type {
  Options,
  query as sdkQuery,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import { type AskUser, tutorBox } from './box.ts'
import { playgroundEnv } from './playground.ts'

export type Query = typeof sdkQuery

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

export type Claude = {
  messages: AsyncIterator<SDKMessage>
  say(text: string): void
  /** 走っている turn を止める。止めた turn も result で閉じる。 */
  interrupt(): Promise<void>
  /** まだ発言を 1 つも流していない新しい session か。 */
  fresh: boolean
  lastTurnAt: number
  toolUses: Map<string, { name: string; input: Record<string, unknown> }>
  stderrTail(): Promise<string>
  kill(): void
  /** process が居なくなると解ける。起こす前なら解けている。 */
  exited(): Promise<void>
}

export type ClaudeDeps = {
  home: string
  tutorDir: string
  learningPreferenceDir: string
  claudePath: string | undefined
  askUser: AskUser | undefined
  reflecting: (() => boolean) | undefined
  query: Query
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

// claude は CLAUDE_ENV_FILE を session ごとに 1 度読み、Bash の command ごとに先に流す。箱の外の command では流す中身も箱の外で走るので、
// Tutor が書ける env/env.sh と env/home は、claude が箱の中の command にだけ付ける SANDBOX_RUNTIME=1 の時に限って使う。
export function writeEnvFile(studyDir: string): string {
  const path = join(studyDir, '.claude-env.sh')
  const envSh = quote(join(studyDir, 'env', 'env.sh'))
  // Tutor が置いた symlink を辿って箱の外の file を上書きしないよう、消してから新しく作る。
  rmSync(path, { force: true })
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants
  const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    writeSync(
      fd,
      `if [ "\${SANDBOX_RUNTIME:-}" = 1 ]; then\n  export HOME=${quote(join(studyDir, 'env', 'home'))}\n  if [ -f ${envSh} ]; then . ${envSh}; fi\nfi\n`,
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

function claudeEnv(envFile: string): { [key: string]: string } {
  const env: { [key: string]: string } = {
    ...ADDED_ENV,
    PATH: pathOutsideHome(),
    CLAUDE_ENV_FILE: envFile,
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
export function wakeClaude(
  deps: ClaudeDeps,
  study: { id: string; dir: string; sessionId: string | null },
): Claude {
  const teaching = readFileSync(join(deps.tutorDir, 'TEACHING.md'), 'utf8')
  const learningPreference = join(deps.learningPreferenceDir, 'LEARNING-PREFERENCE.md')
  const skills = readdirSync(join(deps.tutorDir, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `tutors:${entry.name}`)
  const envFile = writeEnvFile(study.dir)
  const box = tutorBox({
    studyDir: study.dir,
    tutorDir: deps.tutorDir,
    learningPreferenceDir: deps.learningPreferenceDir,
    monicaHome: deps.home,
    ...(deps.askUser && { askUser: deps.askUser }),
    ...(deps.reflecting && { reflecting: deps.reflecting }),
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
    ...(deps.claudePath && { pathToClaudeCodeExecutable: deps.claudePath }),
    ...(study.sessionId && { resume: study.sessionId }),
    env: { ...claudeEnv(envFile), ...playgroundEnv(study.dir, study.id), ...box.env },
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
    fresh: !study.sessionId,
    lastTurnAt: Date.now(),
    toolUses: new Map(),
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
  }
}
