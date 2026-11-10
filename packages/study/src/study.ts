import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { query as sdkQuery, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { EventPublisher, ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, max, sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { listArtifacts, readArtifact, resolveArtifact } from './artifact.ts'
import type { AskUser } from './box.ts'
import { type Claude, type ClaudeDeps, type Query, wakeClaude } from './claude.ts'
import type { StudyMessage, StudyWatchEvent } from './contract.ts'
import reflectionRequest from './reflection.md' with { type: 'text' }
import { study, studyConversation, studyMessage, studyRepo } from './schema.ts'

export type Db = BunSQLiteDatabase

export type StudyLedger = {
  /** 持っている claude すべての group を同期に止める。 */
  stop(): void
  /** 最後の行から 1 時間たった続いている会話と、振り返りの途中で止まった会話を、振り返らせて終える。 */
  endIdleConversations(): Promise<void>
}

// study は job を import しないので、createJobLedger の systemJobs と同じ構造の素のオブジェクトで返す。
export function systemJobs(studyLedger: StudyLedger) {
  return [
    {
      name: 'study.conversation-end',
      every: 5 * 60_000,
      run: () => studyLedger.endIdleConversations(),
    },
  ]
}

// 1 つ 270〜290MB あるので、同時に持つ claude はここまで。
const MAX_CLAUDES = 4
const BASH_COMMAND_CHARS = 200

const IDLE_MS = 60 * 60_000
// claude は resume の session が無いと、この文を stderr に出して exit 1 する。
const NO_SDK_RECORD = 'No conversation found with session ID'
const NO_SDK_RECORD_SUMMARY = 'SDK の記録が消えていたので、振り返らずに終えた'

type Turn = {
  partialText: string
  /** この turn の最後の Tutor の文。振り返りの報告になる。 */
  lastTutorText: string
  reflection: boolean
  ended: Promise<void>
  end(): void
}
type MessageRow = typeof studyMessage.$inferSelect

const REFUSED = 'The user refused to run this command outside the box.'

const toMessage = ({
  id,
  conversationId,
  kind,
  text,
  tool,
  reason,
  permissionState,
  createdAt,
}: MessageRow): StudyMessage => ({
  id,
  conversationId,
  kind,
  text,
  tool,
  reason,
  state: permissionState,
  createdAt,
})

function firstNonEmptyLine(text: string): string | null {
  return text.split('\n').find((line) => line.trim() !== '') ?? null
}

// Tutor が置いた symlink や FIFO を辿って箱の外へ書かないよう、通常の file にだけ足す。
function appendLine(path: string, line: string) {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = constants
  const fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  try {
    writeSync(fd, `\n${line}\n`)
  } finally {
    closeSync(fd)
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function missionLine(dir: string): string | null {
  const line = firstNonEmptyLine(readOrEmpty(join(dir, 'MISSION.md')))
  return line === null ? null : line.replace(/^#+\s*/, '').trim() || null
}

function lastLogLine(dir: string): string | null {
  const line = readOrEmpty(join(dir, 'log.md'))
    .split('\n')
    .map((l) => l.trim())
    .findLast((l) => l !== '' && !l.startsWith('#'))
  return line === undefined ? null : line.replace(/^- /, '')
}

const pad = (n: number) => String(n).padStart(2, '0')

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
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

// GitHub の repo 名は大文字と小文字を区別しない。
const isRepo = (repo: string) => eq(sql`lower(${studyRepo.repo})`, repo.toLowerCase())

function makeLedger(deps: {
  db: Db
  home: string
  claudePath?: string | undefined
  query?: Query
  tutorsDir?: string | undefined
  openInEditor?: (path: string) => Promise<void>
}) {
  const { db, home } = deps
  const studiesDir = join(home, 'studies')
  const learningPreferenceDir = join(home, 'learning-preference')
  // tutorBox が realpath を取るので、Learning Preference の file より先に dir を置く。
  mkdirSync(learningPreferenceDir, { recursive: true, mode: 0o700 })
  const claudeDeps: Omit<ClaudeDeps, 'askUser' | 'reflecting'> = {
    home,
    tutorDir: deps.tutorsDir ?? join(import.meta.dir, '../tutors'),
    learningPreferenceDir,
    claudePath: deps.claudePath,
    query: deps.query ?? sdkQuery,
  }
  const events = new EventPublisher<Record<string, StudyWatchEvent>>()
  const turns = new Map<string, Turn>()
  const claudes = new Map<string, Claude>()
  const waiting = new Map<number, (allowed: boolean) => void>()
  let stopped = false
  const dirOf = (id: string) => join(studiesDir, id)

  // claude は Backend と一緒に居なくなったので、前の Backend で待っていた許可には答える相手が無い。
  db.update(studyMessage)
    .set({ permissionState: 'denied' })
    .where(eq(studyMessage.permissionState, 'pending'))
    .run()

  function publish(studyId: string, event: StudyWatchEvent) {
    const turn = turns.get(studyId)
    if (turn && event.type === 'delta') turn.partialText += event.text
    if (turn && event.type === 'message' && event.message.kind === 'tutor') {
      turn.partialText = ''
      turn.lastTutorText = event.message.text
    }
    events.publish(studyId, event)
  }

  function exists(id: string): boolean {
    return db.select({ id: study.id }).from(study).where(eq(study.id, id)).get() !== undefined
  }

  function mustExist(id: string) {
    if (!exists(id)) throw new ORPCError('NOT_FOUND', { message: `no Study ${id}` })
  }

  function firstMessage(id: string): string | null {
    const row = db
      .select({ text: studyMessage.text })
      .from(studyMessage)
      .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
      .where(and(eq(studyConversation.studyId, id), eq(studyMessage.kind, 'user')))
      .orderBy(asc(studyMessage.id))
      .limit(1)
      .get()
    return row ? (row.text.split('\n')[0] ?? null) : null
  }

  function summary(row: typeof study.$inferSelect) {
    return {
      id: row.id,
      missionLine: missionLine(dirOf(row.id)),
      firstMessage: firstMessage(row.id),
      lastActivityAt: row.lastActiveAt,
    }
  }

  function reposOf(id: string): string[] {
    return db
      .select({ repo: studyRepo.repo })
      .from(studyRepo)
      .where(eq(studyRepo.studyId, id))
      .orderBy(asc(studyRepo.createdAt), asc(sql`rowid`))
      .all()
      .map((row) => row.repo)
  }

  function insertMessage(
    studyId: string,
    values: Omit<typeof studyMessage.$inferInsert, 'createdAt'>,
  ): StudyMessage {
    const row = db
      .insert(studyMessage)
      .values({ ...values, createdAt: new Date() })
      .returning()
      .get()
    const message = toMessage(row)
    publish(studyId, { type: 'message', message })
    return message
  }

  function permissionRow(id: number) {
    return db
      .select({ row: studyMessage, studyId: studyConversation.studyId })
      .from(studyMessage)
      .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
      .where(and(eq(studyMessage.id, id), eq(studyMessage.kind, 'permission')))
      .get()
  }

  /** pending の行だけを答えの状態にし、流し、待っていれば解く。pending でなければ今の行を返す。 */
  function settle(id: number, allowed: boolean): StudyMessage | undefined {
    const found = permissionRow(id)
    if (!found) return undefined
    const updated = db
      .update(studyMessage)
      .set({ permissionState: allowed ? 'allowed' : 'denied' })
      .where(and(eq(studyMessage.id, id), eq(studyMessage.permissionState, 'pending')))
      .returning()
      .get()
    if (!updated) return toMessage(found.row)
    const message = toMessage(updated)
    publish(found.studyId, { type: 'message', message })
    waiting.get(id)?.(allowed)
    waiting.delete(id)
    return message
  }

  function askUserFor(studyId: string): AskUser {
    return async (request, signal) => {
      const ongoing = db
        .select({ id: studyConversation.id })
        .from(studyConversation)
        .where(and(eq(studyConversation.studyId, studyId), isNull(studyConversation.endedAt)))
        .get()
      if (!ongoing || signal.aborted) return { allow: false, message: REFUSED }
      const { id } = insertMessage(studyId, {
        conversationId: ongoing.id,
        kind: 'permission',
        text: request.command,
        reason: request.description,
        permissionState: 'pending',
      })
      const allowed = await new Promise<boolean>((resolve) => {
        waiting.set(id, resolve)
        signal.addEventListener('abort', () => settle(id, false), { once: true })
      })
      return allowed ? { allow: true } : { allow: false, message: REFUSED }
    }
  }

  function touch(tx: Pick<Db, 'update'>, studyId: string, at: Date) {
    tx.update(study).set({ lastActiveAt: at }).where(eq(study.id, studyId)).run()
  }

  function writeToolRow(
    studyId: string,
    conversationId: string,
    claude: Claude,
    toolUseId: string,
  ) {
    const use = claude.toolUses.get(toolUseId)
    if (!use) return
    claude.toolUses.delete(toolUseId)
    const skill = use.input.skill
    if (use.name === 'Skill' && typeof skill === 'string' && skill.startsWith('tutors:')) {
      const name = skill.slice('tutors:'.length)
      const last = db
        .select({ text: studyMessage.text })
        .from(studyMessage)
        .where(
          and(
            eq(studyMessage.conversationId, conversationId),
            eq(studyMessage.kind, 'tutor_switch'),
          ),
        )
        .orderBy(desc(studyMessage.id))
        .limit(1)
        .get()
      if (last?.text !== name) {
        insertMessage(studyId, { conversationId, kind: 'tutor_switch', text: name })
      }
      return
    }
    insertMessage(studyId, {
      conversationId,
      kind: 'tool',
      text: toolText(use.name, use.input),
      tool: use.name,
    })
  }

  function translate(studyId: string, conversationId: string, claude: Claude, message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init') {
      db.update(studyConversation)
        .set({ sessionId: message.session_id })
        .where(and(eq(studyConversation.id, conversationId), isNull(studyConversation.sessionId)))
        .run()
    } else if (
      message.type === 'stream_event' &&
      message.event.type === 'content_block_delta' &&
      message.event.delta.type === 'text_delta'
    ) {
      publish(studyId, { type: 'delta', text: message.event.delta.text })
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text !== '') {
          insertMessage(studyId, { conversationId, kind: 'tutor', text: block.text })
        } else if (block.type === 'tool_use') {
          claude.toolUses.set(block.id, {
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          })
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result')
          writeToolRow(studyId, conversationId, claude, block.tool_use_id)
      }
    }
  }

  /** turn の終わりまで claude の message を読む。失敗なら result の文か stderr の末尾を返す。 */
  async function readTurn(studyId: string, conversationId: string, claude: Claude) {
    for (;;) {
      let next: IteratorResult<SDKMessage>
      try {
        // for await を break すると iterator が閉じるので、turn ごとに result まで next() を呼ぶ。
        next = await claude.messages.next()
      } catch {
        next = { done: true, value: undefined }
      }
      if (next.done) {
        if (claudes.get(studyId) === claude) claudes.delete(studyId)
        claude.kill()
        return (await claude.stderrTail()) || 'claude exited before the turn ended'
      }
      const message = next.value
      if (message.type === 'result') {
        if (!message.is_error) return null
        return message.subtype === 'success' ? message.result : message.errors.join('\n')
      }
      translate(studyId, conversationId, claude, message)
    }
  }

  function wake(studyId: string, conversation: { sessionId: string | null }): Claude {
    if (claudes.size >= MAX_CLAUDES) {
      const idle = [...claudes].filter(([id]) => !turns.has(id))
      const oldest = idle.reduce<[string, Claude] | null>(
        (found, entry) => (!found || entry[1].lastTurnAt < found[1].lastTurnAt ? entry : found),
        null,
      )
      if (oldest) {
        oldest[1].kill()
        claudes.delete(oldest[0])
      }
    }
    const claude = wakeClaude(
      {
        ...claudeDeps,
        askUser: askUserFor(studyId),
        reflecting: () => turns.get(studyId)?.reflection === true,
      },
      {
        id: studyId,
        dir: dirOf(studyId),
        sessionId: conversation.sessionId,
      },
    )
    claudes.set(studyId, claude)
    return claude
  }

  /** 会話を終え、claude を閉じる。振り返らずに終えた時は、その理由を log.md の末尾にも書く。 */
  function finish(studyId: string, conversationId: string, ending: string | null, logged: boolean) {
    db.update(studyConversation)
      .set({ endedAt: new Date(), summary: ending })
      .where(and(eq(studyConversation.id, conversationId), isNull(studyConversation.endedAt)))
      .run()
    claudes.get(studyId)?.kill()
    claudes.delete(studyId)
    if (!logged || ending === null) return
    try {
      appendLine(join(dirOf(studyId), 'log.md'), `- ${localIso(new Date())} ${ending}`)
    } catch (error) {
      console.error(`[study] could not write log.md of ${studyId}: ${(error as Error).message}`)
    }
  }

  function finishAfter(studyId: string, conversationId: string, turn: Turn, error: string | null) {
    if (error?.includes(NO_SDK_RECORD)) {
      finish(studyId, conversationId, NO_SDK_RECORD_SUMMARY, true)
    } else if (turn.reflection && error !== null) {
      finish(
        studyId,
        conversationId,
        `振り返りの turn が失敗した: ${firstNonEmptyLine(error)}`,
        true,
      )
    } else if (turn.reflection) {
      finish(studyId, conversationId, firstNonEmptyLine(turn.lastTutorText), false)
    }
  }

  async function runTurn(
    studyId: string,
    conversation: { id: string; startedAt: Date; sessionId: string | null },
    text: string,
    turn: Turn,
  ) {
    let error: string | null
    try {
      const claude = claudes.get(studyId) ?? wake(studyId, conversation)
      claude.lastTurnAt = Date.now()
      claude.say(
        claude.fresh
          ? `Study Conversation started at ${localIso(conversation.startedAt)}\n${text}`
          : text,
      )
      claude.fresh = false
      error = await readTurn(studyId, conversation.id, claude)
      claude.lastTurnAt = Date.now()
    } catch (thrown) {
      error = (thrown as Error).message
    }
    // stop() が殺した claude の turn では会話を終えず、次の Backend の Job が振り返らせる。
    if (!stopped) finishAfter(studyId, conversation.id, turn, error)
    touch(db, studyId, new Date())
    turns.delete(studyId)
    publish(studyId, { type: 'turn-ended', error })
    turn.end()
  }

  function refuseWhenFull(studyId: string) {
    if (
      !claudes.has(studyId) &&
      claudes.size >= MAX_CLAUDES &&
      [...claudes.keys()].every((id) => turns.has(id))
    ) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: `${MAX_CLAUDES} Studies are in a turn; try again when one ends`,
      })
    }
  }

  /** turn の印を await の前に確かめて付ける。 */
  function takeTurn(studyId: string, reflection: boolean): Turn {
    if (turns.has(studyId)) {
      throw new ORPCError('CONFLICT', { message: `a turn is already running in ${studyId}` })
    }
    refuseWhenFull(studyId)
    const { promise, resolve } = Promise.withResolvers<void>()
    const turn = { partialText: '', lastTutorText: '', reflection, ended: promise, end: resolve }
    turns.set(studyId, turn)
    return turn
  }

  /** ユーザーの発言を書いて turn を始め、turn の終わりを待たずに書いた行を返す。 */
  function startTurn(studyId: string, text: string): StudyMessage {
    mustExist(studyId)
    const turn = takeTurn(studyId, false)
    const now = new Date()
    const written = db.transaction((tx) => {
      const ongoing = tx
        .select()
        .from(studyConversation)
        .where(and(eq(studyConversation.studyId, studyId), isNull(studyConversation.endedAt)))
        .get()
      const conversation =
        ongoing ??
        tx
          .insert(studyConversation)
          .values({ id: `sc-${Bun.randomUUIDv7()}`, studyId, startedAt: now })
          .returning()
          .get()
      const row = tx
        .insert(studyMessage)
        .values({ conversationId: conversation.id, createdAt: now, kind: 'user', text })
        .returning()
        .get()
      touch(tx, studyId, now)
      return { conversation, row }
    })
    publish(studyId, { type: 'turn-started', conversationId: written.conversation.id })
    const message = toMessage(written.row)
    publish(studyId, { type: 'message', message })
    void runTurn(studyId, written.conversation, text, turn)
    return message
  }

  const hasReflection = (conversationId: string) =>
    db
      .select({ id: studyMessage.id })
      .from(studyMessage)
      .where(
        and(eq(studyMessage.conversationId, conversationId), eq(studyMessage.kind, 'reflection')),
      )
      .get() !== undefined

  /** 最後の行の時刻。行の無い会話は始めた時刻。 */
  function lastRowAt(conversation: { id: string; startedAt: Date }): number {
    const last = db
      .select({ at: max(studyMessage.createdAt) })
      .from(studyMessage)
      .where(eq(studyMessage.conversationId, conversation.id))
      .get()
    return (last?.at ?? conversation.startedAt).getTime()
  }

  const isIdle = (conversation: { id: string; startedAt: Date }) =>
    hasReflection(conversation.id) || lastRowAt(conversation) <= Date.now() - IDLE_MS

  /** 振り返りの turn を始める。印を取った後に見直し、もう終わっていたか、idle を求めて話が続いていれば何もしない。 */
  function startReflection(studyId: string, conversationId: string, idle: boolean) {
    const turn = takeTurn(studyId, true)
    const conversation = db
      .select()
      .from(studyConversation)
      .where(eq(studyConversation.id, conversationId))
      .get()
    if (!conversation || conversation.endedAt !== null || (idle && !isIdle(conversation))) {
      turns.delete(studyId)
      return
    }
    // 振り返りの途中で Backend が止まった会話は、区切りを 2 つ描かないよう行を足さずに始め直す。
    const row = hasReflection(conversationId)
      ? null
      : db
          .insert(studyMessage)
          .values({ conversationId, createdAt: new Date(), kind: 'reflection', text: '' })
          .returning()
          .get()
    publish(studyId, { type: 'turn-started', conversationId })
    if (row) publish(studyId, { type: 'message', message: toMessage(row) })
    void runTurn(studyId, conversation, reflectionRequest, turn)
  }

  /** pending の許可を断って turn を止め、その終わりを待ってから振り返りの turn を始める。 */
  async function endConversation(studyId: string, conversationId: string, idle: boolean) {
    const pending = db
      .select({ id: studyMessage.id })
      .from(studyMessage)
      .where(
        and(
          eq(studyMessage.conversationId, conversationId),
          eq(studyMessage.permissionState, 'pending'),
        ),
      )
      .all()
    const turn = turns.get(studyId)
    if (turn && pending.length === 0) {
      throw new ORPCError('CONFLICT', { message: `a turn is already running in ${studyId}` })
    }
    refuseWhenFull(studyId)
    if (turn) {
      for (const row of pending) settle(row.id, false)
      try {
        await claudes.get(studyId)?.interrupt()
      } catch {
        // claude が先に居なくなっても、turn は readTurn が閉じる。
      }
      await turn.ended
    }
    // 止めた turn の Tutor の行で最後の行が新しくなるので、止めた後は無発言を見直さない。
    startReflection(studyId, conversationId, idle && !turn)
  }

  function ongoingOf(studyId: string) {
    return db
      .select()
      .from(studyConversation)
      .where(and(eq(studyConversation.studyId, studyId), isNull(studyConversation.endedAt)))
      .get()
  }

  const procedures = {
    start(): { id: string } {
      const id = `study-${Bun.randomUUIDv7()}`
      mkdirSync(dirOf(id), { recursive: true, mode: 0o700 })
      const now = new Date()
      db.insert(study).values({ id, createdAt: now, lastActiveAt: now }).run()
      return { id }
    },

    list() {
      const rows = db.select().from(study).orderBy(desc(study.lastActiveAt)).all()
      return {
        studies: rows.map((row) => ({
          ...summary(row),
          lastLogLine: lastLogLine(dirOf(row.id)),
          waitingPermission:
            db
              .select({ id: studyMessage.id })
              .from(studyMessage)
              .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
              .where(
                and(
                  eq(studyConversation.studyId, row.id),
                  eq(studyMessage.permissionState, 'pending'),
                ),
              )
              .get() !== undefined,
          repos: reposOf(row.id),
        })),
      }
    },

    get(id: string) {
      mustExist(id)
      const conversations = db
        .select()
        .from(studyConversation)
        .where(eq(studyConversation.studyId, id))
        .orderBy(desc(studyConversation.startedAt), desc(studyConversation.id))
        .all()
      return {
        id,
        dir: dirOf(id),
        missionLine: missionLine(dirOf(id)),
        firstMessage: firstMessage(id),
        running: turns.has(id),
        repos: reposOf(id),
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          startedAt: conversation.startedAt,
          endedAt: conversation.endedAt,
          summary: conversation.summary,
          messages: db
            .select()
            .from(studyMessage)
            .where(eq(studyMessage.conversationId, conversation.id))
            .orderBy(asc(studyMessage.id))
            .all()
            .map(toMessage),
        })),
      }
    },

    linkRepo(id: string, repo: string): Record<string, never> {
      mustExist(id)
      db.insert(studyRepo)
        .values({ studyId: id, repo, createdAt: new Date() })
        .onConflictDoNothing()
        .run()
      return {}
    },

    unlinkRepo(id: string, repo: string): Record<string, never> {
      db.delete(studyRepo)
        .where(and(eq(studyRepo.studyId, id), isRepo(repo)))
        .run()
      return {}
    },

    studiesOfRepo(repo: string) {
      const rows = db
        .select({ study })
        .from(study)
        .innerJoin(studyRepo, eq(studyRepo.studyId, study.id))
        .where(isRepo(repo))
        .orderBy(desc(study.lastActiveAt))
        .all()
      return { studies: rows.map((row) => summary(row.study)) }
    },

    send(id: string, text: string) {
      return { message: startTurn(id, text) }
    },

    async endConversation(id: string): Promise<{ conversationId: string }> {
      mustExist(id)
      const ongoing = ongoingOf(id)
      if (!ongoing)
        throw new ORPCError('NOT_FOUND', { message: `no ongoing Study Conversation in ${id}` })
      await endConversation(id, ongoing.id, false)
      return { conversationId: ongoing.id }
    },

    listArtifacts(id: string) {
      mustExist(id)
      return { artifacts: listArtifacts(dirOf(id)) }
    },

    readArtifact(id: string, path: string) {
      mustExist(id)
      return { path, content: readArtifact(dirOf(id), path) }
    },

    async openArtifact(id: string, path: string): Promise<void> {
      mustExist(id)
      const real = resolveArtifact(dirOf(id), path)
      if (!deps.openInEditor) throw new Error('no editor to open artifacts in')
      try {
        await deps.openInEditor(real)
      } catch (error) {
        // ORPCError でない Error は、ブラウザに message を伏せて届く。
        throw new ORPCError('INTERNAL_SERVER_ERROR', { message: (error as Error).message })
      }
    },

    answerPermission(id: number, allow: boolean): StudyMessage {
      const message = settle(id, allow)
      if (!message) throw new ORPCError('NOT_FOUND', { message: `no permission row ${id}` })
      return message
    },

    watch(id: string, signal: AbortSignal | undefined): AsyncGenerator<StudyWatchEvent> {
      mustExist(id)
      // 既定の 100 を超えると古い event から捨てられ、delta が抜けると途中の文が壊れる。
      const subscribed = events.subscribe(id, {
        ...(signal && { signal }),
        maxBufferedEvents: Number.POSITIVE_INFINITY,
      })
      // 購読と snapshot の間に await を挟まないので、snapshot の後の event を落とさず、二重にもしない。
      const last = db
        .select({ id: max(studyMessage.id) })
        .from(studyMessage)
        .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
        .where(eq(studyConversation.studyId, id))
        .get()
      const snapshot: StudyWatchEvent = {
        type: 'snapshot',
        running: turns.has(id),
        lastMessageId: last?.id ?? null,
        partialText: turns.get(id)?.partialText ?? '',
      }
      return (async function* () {
        yield snapshot
        yield* subscribed
      })()
    },
  }

  const ledger: StudyLedger = {
    stop() {
      stopped = true
      for (const claude of claudes.values()) claude.kill()
      claudes.clear()
    },
    async endIdleConversations() {
      const failures: string[] = []
      const ongoing = db
        .select()
        .from(studyConversation)
        .where(isNull(studyConversation.endedAt))
        .all()
      for (const conversation of ongoing) {
        const running = turns.has(conversation.studyId)
        try {
          if (!isIdle(conversation)) continue
          await endConversation(conversation.studyId, conversation.id, true)
        } catch (error) {
          // 走っている turn と、claude が 4 つとも turn の中の時は、次の回に回す。
          if (error instanceof ORPCError && (running || error.code === 'TOO_MANY_REQUESTS'))
            continue
          failures.push(`${conversation.id}: ${(error as Error).message}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not end the idle Study Conversations: ${failures.join('; ')}`)
      }
    },
  }
  return { ledger, procedures }
}

type Internals = ReturnType<typeof makeLedger>['procedures']

// StudyLedger の型は Backend の組み立てが呼ぶものだけに保ち、procedure が使う中身は StudyLedger を key にここへ置く。
const internalsOf = new WeakMap<StudyLedger, Internals>()

export function internals(studyLedger: StudyLedger): Internals {
  const found = internalsOf.get(studyLedger)
  if (!found) throw new Error('this StudyLedger was not made by createStudyLedger')
  return found
}

export function createStudyLedger(deps: Parameters<typeof makeLedger>[0]): StudyLedger {
  const { ledger, procedures } = makeLedger(deps)
  internalsOf.set(ledger, procedures)
  return ledger
}
