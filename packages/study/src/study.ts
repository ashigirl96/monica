import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { query as sdkQuery, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { EventPublisher, ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { listArtifacts, readArtifact, resolveArtifact } from './artifact.ts'
import type { AskUser } from './box.ts'
import { type Claude, type ClaudeDeps, type Query, wakeClaude } from './claude.ts'
import type { StudyMessage, StudyWatchEvent } from './contract.ts'
import { study, studyConversation, studyMessage } from './schema.ts'

export type Db = BunSQLiteDatabase

export type StudyLedger = {
  /** 持っている claude すべての group を同期に止める。 */
  stop(): void
}

// 1 つ 270〜290MB あるので、同時に持つ claude はここまで。
const MAX_CLAUDES = 4
const BASH_COMMAND_CHARS = 200

type Turn = { partialText: string }
type MessageRow = typeof studyMessage.$inferSelect

const toMessage = ({
  id,
  conversationId,
  kind,
  text,
  tool,
  createdAt,
}: MessageRow): StudyMessage => ({
  id,
  conversationId,
  kind,
  text,
  tool,
  createdAt,
})

function firstNonEmptyLine(text: string): string | null {
  return text.split('\n').find((line) => line.trim() !== '') ?? null
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

function makeLedger(deps: {
  db: Db
  home: string
  claudePath?: string | undefined
  askUser?: AskUser
  query?: Query
  tutorsDir?: string | undefined
  openInEditor?: (path: string) => Promise<void>
}) {
  const { db, home } = deps
  const studiesDir = join(home, 'studies')
  const learningPreferenceDir = join(home, 'learning-preference')
  // tutorBox が realpath を取るので、Learning Preference の file より先に dir を置く。
  mkdirSync(learningPreferenceDir, { recursive: true, mode: 0o700 })
  const claudeDeps: ClaudeDeps = {
    home,
    tutorDir: deps.tutorsDir ?? join(import.meta.dir, '../tutors'),
    learningPreferenceDir,
    claudePath: deps.claudePath,
    askUser: deps.askUser,
    query: deps.query ?? sdkQuery,
  }
  const events = new EventPublisher<Record<string, StudyWatchEvent>>()
  const turns = new Map<string, Turn>()
  const claudes = new Map<string, Claude>()
  const dirOf = (id: string) => join(studiesDir, id)

  function publish(studyId: string, event: StudyWatchEvent) {
    const turn = turns.get(studyId)
    if (turn && event.type === 'delta') turn.partialText += event.text
    if (turn && event.type === 'message' && event.message.kind === 'tutor') turn.partialText = ''
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
    const claude = wakeClaude(claudeDeps, {
      id: studyId,
      dir: dirOf(studyId),
      sessionId: conversation.sessionId,
    })
    claudes.set(studyId, claude)
    return claude
  }

  async function runTurn(
    studyId: string,
    conversation: { id: string; startedAt: Date; sessionId: string | null },
    text: string,
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
    touch(db, studyId, new Date())
    turns.delete(studyId)
    publish(studyId, { type: 'turn-ended', error })
  }

  /** ユーザーの発言を書いて turn を始め、turn の終わりを待たずに書いた行を返す。 */
  function startTurn(studyId: string, text: string): StudyMessage {
    mustExist(studyId)
    if (turns.has(studyId)) {
      throw new ORPCError('CONFLICT', { message: `a turn is already running in ${studyId}` })
    }
    if (
      !claudes.has(studyId) &&
      claudes.size >= MAX_CLAUDES &&
      [...claudes.keys()].every((id) => turns.has(id))
    ) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: `${MAX_CLAUDES} Studies are in a turn; try again when one ends`,
      })
    }
    turns.set(studyId, { partialText: '' })
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
    void runTurn(studyId, written.conversation, text)
    return message
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
          id: row.id,
          missionLine: missionLine(dirOf(row.id)),
          firstMessage: firstMessage(row.id),
          lastActivityAt: row.lastActiveAt,
          lastLogLine: lastLogLine(dirOf(row.id)),
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
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          startedAt: conversation.startedAt,
          endedAt: conversation.endedAt,
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

    send(id: string, text: string) {
      return { message: startTurn(id, text) }
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
      for (const claude of claudes.values()) claude.kill()
      claudes.clear()
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
