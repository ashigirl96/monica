import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import type { deleteSession } from '@anthropic-ai/claude-agent-sdk'
import { localIso } from '@monica/ui/local-time'
import { EventPublisher } from '@orpc/server'
import { and, asc, desc, eq, isNull, lt, max } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { STALE_MS } from './activity.ts'
import type { AskUser } from './box.ts'
import {
  envFileOf,
  type TurnEnd,
  type TutorClaudes,
  type TutorEvent,
  type TutorRequest,
} from './claude.ts'
import { cleanPrototypes, type createRunner, removePlayground, type Tools } from './cleanup.ts'
import type { Choice, StudyMessage, StudyRefusal, StudyWatchEvent } from './contract.ts'
import { study, studyConversation, studyMessage } from './schema.ts'

type Db = BunSQLiteDatabase
type MessageRow = typeof studyMessage.$inferSelect

const IDLE_MS = 60 * 60_000
const NO_SDK_RECORD_SUMMARY = 'SDK の記録が消えていたので、振り返らずに終えた'
const REFUSED = 'The user refused to run this command outside the box.'

/** 今は受けられない操作。理由は contract の 1 つの語彙から選ぶ。 */
export type Refusal = { refused: StudyRefusal; message: string }

const refusalMessages = {
  'turn-running': (id) => `a turn is already running in ${id}`,
  'conversation-ending': (id) => `the Study Conversation of ${id} is ending`,
  'playground-cleaning': (id) => `the Playground of ${id} is being cleaned up`,
  'study-removing': (id) => `${id} is being removed`,
  'tutor-capacity': () => 'every Tutor claude is in a turn; try again when one ends',
} satisfies Record<StudyRefusal, (id: string) => string>

const refusal = (id: string, reason: StudyRefusal): Refusal => ({
  refused: reason,
  message: refusalMessages[reason](id),
})

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'refused' in value

export type Turn = {
  mode: TutorRequest['kind']
  /** 最後の tutor の行より後の Tutor の文。watch の snapshot になる。 */
  partialText: string
  running: boolean
  ended: Promise<void>
  end(): void
}

/** Study を今どの操作が持っているか。持っていない Study は Map に居ない。 */
export type Occupancy =
  | { kind: 'turn'; turn: Turn }
  /** 許可を待つ turn を止めてから、振り返りか終わりに渡すまで。 */
  | { kind: 'closing'; turn: Turn; done: Promise<void> }
  | { kind: 'cleaning'; done: Promise<void> }
  /** prior は削除が止めて終わりを待つ、前に Study を持っていた操作。 */
  | { kind: 'removing'; prior: Occupancy | undefined }

export type Want = 'send' | 'reflect' | 'leave' | 'shell' | 'clean' | 'remove'

export type Verdict = 'go' | StudyRefusal | { interrupt: Turn }

/**
 * Study を持つ操作ごとに、別の操作を受けるかを決める。reflect と leave は会話を終える頼み。
 *
 *   want \ state | turn                          | closing             | cleaning            | removing
 *   send         | turn-running                  | conversation-ending | playground-cleaning | study-removing
 *   reflect      | 許可待ちなら interrupt、他は turn-running | conversation-ending | playground-cleaning | study-removing
 *   leave        | 許可待ちなら interrupt、他は turn-running | conversation-ending | go                  | study-removing
 *   shell        | go                            | go                  | playground-cleaning | study-removing
 *   clean        | turn-running                  | conversation-ending | playground-cleaning | study-removing
 *   remove       | go                            | go                  | go                  | study-removing
 */
export function decide(
  state: Occupancy | undefined,
  want: 'reflect' | 'leave',
  permissionPending: boolean,
): Verdict
export function decide(
  state: Occupancy | undefined,
  want: Exclude<Want, 'reflect' | 'leave'>,
): 'go' | StudyRefusal
export function decide(
  state: Occupancy | undefined,
  want: Want,
  permissionPending = false,
): Verdict {
  if (!state) return 'go'
  switch (state.kind) {
    case 'removing':
      return 'study-removing'
    case 'cleaning':
      return want === 'leave' || want === 'remove' ? 'go' : 'playground-cleaning'
    case 'closing':
      return want === 'shell' || want === 'remove' ? 'go' : 'conversation-ending'
    case 'turn':
      if (want === 'shell' || want === 'remove') return 'go'
      if ((want === 'reflect' || want === 'leave') && permissionPending) {
        return { interrupt: state.turn }
      }
      return 'turn-running'
  }
}

/** Study Conversation の終わり方。 */
export type Ending =
  | { kind: 'without-reflection' }
  | { kind: 'reflected'; report: string }
  | { kind: 'reflection-failed'; error: string }
  | { kind: 'record-missing' }

/** 終わった turn が会話をどう終えるか。null なら会話は続く。 */
export function endingAfter(
  mode: Turn['mode'],
  end: Exclude<TurnEnd, { kind: 'stopped' }>,
): Ending | null {
  if (end.kind === 'session-lost') return { kind: 'record-missing' }
  if (mode === 'say') return null
  return end.kind === 'answered'
    ? { kind: 'reflected', report: end.lastText }
    : { kind: 'reflection-failed', error: end.error }
}

/** 会話の終わり方が残すもの。振り返らずに終えた理由は log.md の末尾にも書く。 */
export function recordOf(ending: Ending): { summary: string | null; logged: boolean } {
  switch (ending.kind) {
    case 'without-reflection':
      return { summary: null, logged: false }
    case 'reflected':
      return { summary: firstNonEmptyLine(ending.report), logged: false }
    case 'reflection-failed':
      return {
        summary: `振り返りの turn が失敗した: ${firstNonEmptyLine(ending.error)}`,
        logged: true,
      }
    case 'record-missing':
      return { summary: NO_SDK_RECORD_SUMMARY, logged: true }
  }
}

export function firstNonEmptyLine(text: string): string | null {
  return text.split('\n').find((line) => line.trim() !== '') ?? null
}

export const toMessage = ({
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

const isStale = (row: { lastActiveAt: Date } | undefined) =>
  row !== undefined && row.lastActiveAt.getTime() < Date.now() - STALE_MS

function doneOf(state: Occupancy): Promise<void> {
  switch (state.kind) {
    case 'turn':
      return state.turn.ended
    case 'closing':
    case 'cleaning':
      return state.done
    case 'removing':
      return state.prior ? doneOf(state.prior) : Promise.resolve()
  }
}

function liveTurn(state: Occupancy | undefined): Turn | undefined {
  switch (state?.kind) {
    case 'turn':
    case 'closing':
      return state.turn.running ? state.turn : undefined
    case 'removing':
      return liveTurn(state.prior)
    default:
      return undefined
  }
}

/**
 * Study ごとに、どの操作が Study を持つかと Study Conversation の進め方を 1 か所で持つ。
 * claude の数の上限は tutors の reply が持ち、ここでは数えない。
 */
export function createStudyLifecycle(deps: {
  db: Db
  home: string
  dirOf: (studyId: string) => string
  trashDir: string
  tutors: (askUser: (studyId: string) => AskUser) => TutorClaudes
  runner: ReturnType<typeof createRunner>
  tools: Tools | undefined
  deleteSession: typeof deleteSession
}) {
  const { db, dirOf } = deps
  // null は Study が消えた印で、watch はそれまでの event を流し終えてから閉じる。
  const events = new EventPublisher<Record<string, StudyWatchEvent | null>>()
  const states = new Map<string, Occupancy>()
  const waiting = new Map<number, (allowed: boolean) => void>()
  const tutors = deps.tutors(askUserFor)

  // claude は Backend と一緒に居なくなったので、前の Backend で待っていた許可には答える相手が無い。
  db.update(studyMessage)
    .set({ permissionState: 'denied' })
    .where(eq(studyMessage.permissionState, 'pending'))
    .run()

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
    events.publish(studyId, { type: 'message', message })
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
    events.publish(found.studyId, { type: 'message', message })
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

  /** turn の出来事を行と watch の event にする。 */
  function record(studyId: string, conversationId: string, turn: Turn, event: TutorEvent) {
    switch (event.type) {
      case 'session':
        db.update(studyConversation)
          .set({ sessionId: event.sessionId })
          .where(and(eq(studyConversation.id, conversationId), isNull(studyConversation.sessionId)))
          .run()
        return
      case 'delta':
        turn.partialText += event.text
        events.publish(studyId, { type: 'delta', text: event.text })
        return
      case 'tutor':
        turn.partialText = ''
        insertMessage(studyId, { conversationId, kind: 'tutor', text: event.text })
        return
      case 'tool':
        insertMessage(studyId, { conversationId, kind: 'tool', text: event.text, tool: event.tool })
        return
      case 'tutor-switch': {
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
        if (last?.text !== event.tutor) {
          insertMessage(studyId, { conversationId, kind: 'tutor_switch', text: event.tutor })
        }
        return
      }
    }
  }

  /** 会話を 1 度だけ終え、claude を閉じる。 */
  function commitEnding(studyId: string, conversationId: string, ending: Ending) {
    const { summary, logged } = recordOf(ending)
    const ended = db
      .update(studyConversation)
      .set({ endedAt: new Date(), summary })
      .where(and(eq(studyConversation.id, conversationId), isNull(studyConversation.endedAt)))
      .returning({ id: studyConversation.id })
      .get()
    if (ended) events.publish(studyId, { type: 'conversation-ended', conversationId })
    void tutors.close(studyId)
    if (!logged || summary === null) return
    try {
      appendLine(join(dirOf(studyId), 'log.md'), `- ${localIso(new Date())} ${summary}`)
    } catch (error) {
      console.error(`[study] could not write log.md of ${studyId}: ${(error as Error).message}`)
    }
  }

  async function runTurn(
    studyId: string,
    conversationId: string,
    turn: Turn,
    ended: Promise<TurnEnd>,
  ) {
    const end = await ended
    // stop() が殺した claude の turn では会話を終えず、次の Backend の Job が振り返らせる。
    const ending = end.kind === 'stopped' ? null : endingAfter(turn.mode, end)
    if (ending) commitEnding(studyId, conversationId, ending)
    touch(db, studyId, new Date())
    turn.running = false
    const state = states.get(studyId)
    if (state?.kind === 'turn' && state.turn === turn) states.delete(studyId)
    // Study を空けてから流すので、turn-ended を見た画面の読み直しと送信は断られない。
    events.publish(studyId, {
      type: 'turn-ended',
      error: end.kind === 'answered' ? null : end.error,
    })
    turn.end()
  }

  /** Tutor に答えさせ、Study を turn で持つ。claude の席が無ければ prepare を呼ばずに断る。 */
  function begin<T>(
    studyId: string,
    request: TutorRequest,
    prepare: () => {
      conversation: { id: string; startedAt: Date; sessionId: string | null }
      value: T
    },
  ): T | Refusal {
    const { promise, resolve } = Promise.withResolvers<void>()
    const turn: Turn = {
      mode: request.kind,
      partialText: '',
      running: true,
      ended: promise,
      end: resolve,
    }
    const replied = tutors.reply(studyId, request, () => {
      const { conversation, value } = prepare()
      return {
        conversation,
        value: { value, conversationId: conversation.id },
        onEvent: (event: TutorEvent) => record(studyId, conversation.id, turn, event),
      }
    })
    if (replied === 'full') return refusal(studyId, 'tutor-capacity')
    states.set(studyId, { kind: 'turn', turn })
    void runTurn(studyId, replied.value.conversationId, turn, replied.ended)
    return replied.value.value
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

  /** turn の無い Study の会話を、振り返りの turn を始めるか振り返らずに終える。もう終わっていたか、idle を求めて話が続いていれば何もしない。 */
  function endNow(
    studyId: string,
    conversationId: string,
    reflect: boolean,
    idle: boolean,
  ): Refusal | undefined {
    if (!reflect) {
      commitEnding(studyId, conversationId, { kind: 'without-reflection' })
      return undefined
    }
    const conversation = db
      .select()
      .from(studyConversation)
      .where(eq(studyConversation.id, conversationId))
      .get()
    if (!conversation || conversation.endedAt !== null || (idle && !isIdle(conversation))) {
      return undefined
    }
    const row = begin(studyId, { kind: 'reflect' }, () => ({
      conversation,
      // 振り返りの途中で Backend が止まった会話は、区切りを 2 つ描かないよう行を足さずに始め直す。
      value: hasReflection(conversationId)
        ? null
        : db
            .insert(studyMessage)
            .values({ conversationId, createdAt: new Date(), kind: 'reflection', text: '' })
            .returning()
            .get(),
    }))
    if (isRefusal(row)) return row
    events.publish(studyId, { type: 'turn-started', conversationId })
    if (row) events.publish(studyId, { type: 'message', message: toMessage(row) })
    return undefined
  }

  /** pending の許可を断って turn を止め、その終わりを待ってから、振り返りの turn を始めるか振り返らずに終える。 */
  async function endConversation(
    studyId: string,
    conversationId: string,
    reflect: boolean,
    idle: boolean,
  ): Promise<Refusal | undefined> {
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
    const verdict = decide(states.get(studyId), reflect ? 'reflect' : 'leave', pending.length > 0)
    if (verdict === 'go') return endNow(studyId, conversationId, reflect, idle)
    if (typeof verdict === 'string') return refusal(studyId, verdict)
    const { promise: done, resolve } = Promise.withResolvers<void>()
    const closing: Occupancy = { kind: 'closing', turn: verdict.interrupt, done }
    states.set(studyId, closing)
    try {
      for (const row of pending) settle(row.id, false)
      await tutors.interrupt(studyId)
      await verdict.interrupt.ended
      // closing の Study を奪えるのは削除だけ。
      if (states.get(studyId) !== closing) return refusal(studyId, 'study-removing')
      states.delete(studyId)
      // 止めた turn の Tutor の行で最後の行が新しくなるので、止めた後は無発言を見直さない。
      return endNow(studyId, conversationId, reflect, false)
    } finally {
      if (states.get(studyId) === closing) states.delete(studyId)
      resolve()
    }
  }

  return {
    /** ユーザーの発言を書いて turn を始め、turn の終わりを待たずに書いた行を返す。 */
    send(studyId: string, text: string, choice: Choice): StudyMessage | Refusal {
      const verdict = decide(states.get(studyId), 'send')
      if (verdict !== 'go') return refusal(studyId, verdict)
      const now = new Date()
      const written = begin(studyId, { kind: 'say', text, choice }, () => {
        const value = db.transaction((tx) => {
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
        return { conversation: value.conversation, value }
      })
      if (isRefusal(written)) return written
      events.publish(studyId, { type: 'turn-started', conversationId: written.conversation.id })
      const message = toMessage(written.row)
      events.publish(studyId, { type: 'message', message })
      return message
    },

    /** 続いている会話を終える。振り返るなら、振り返りの turn を始めた所で返る。 */
    end: (studyId: string, conversationId: string, reflect: boolean) =>
      endConversation(studyId, conversationId, reflect, false),

    async endIdleConversations() {
      const failures: string[] = []
      const ongoing = db
        .select()
        .from(studyConversation)
        .where(isNull(studyConversation.endedAt))
        .all()
      for (const conversation of ongoing) {
        try {
          if (!isIdle(conversation)) continue
          // 振り返りの行があるのは、振り返りの途中で Backend が止まった会話。断られた会話は次の回に回す。
          await endConversation(
            conversation.studyId,
            conversation.id,
            hasReflection(conversation.id),
            true,
          )
        } catch (error) {
          failures.push(`${conversation.id}: ${(error as Error).message}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not end the idle Study Conversations: ${failures.join('; ')}`)
      }
    },

    /** Study を持っていた操作を止めて終わりを待ち、dir を捨て場へ移して行を消し、watch を閉じる。 */
    async remove(studyId: string): Promise<Refusal | undefined> {
      const prior = states.get(studyId)
      const verdict = decide(prior, 'remove')
      if (verdict !== 'go') return refusal(studyId, verdict)
      const removing: Occupancy = { kind: 'removing', prior }
      states.set(studyId, removing)
      try {
        const pending = db
          .select({ id: studyMessage.id })
          .from(studyMessage)
          .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
          .where(
            and(
              eq(studyConversation.studyId, studyId),
              eq(studyMessage.permissionState, 'pending'),
            ),
          )
          .all()
        for (const row of pending) settle(row.id, false)
        // 止めた claude が消した dir に書き戻さず、turn-ended が行の消えた後に流れないようにする。
        await Promise.all([tutors.close(studyId), prior && doneOf(prior)])
        const sessionIds = db
          .select({ sessionId: studyConversation.sessionId })
          .from(studyConversation)
          .where(eq(studyConversation.studyId, studyId))
          .all()
          .flatMap((row) => (row.sessionId ? [row.sessionId] : []))
        const dir = dirOf(studyId)
        const trashed = join(deps.trashDir, studyId)
        const tree = join(trashed, 'tree')
        mkdirSync(trashed, { recursive: true })
        const moved = existsSync(dir)
        // claude は記録の dir 名を cwd の realpath から作るので、symlink を通る path では消せない。
        const sessionDir = moved ? realpathSync(dir) : dir
        try {
          if (moved) renameSync(dir, tree)
        } catch (error) {
          rmSync(trashed, { recursive: true, force: true })
          throw error
        }
        try {
          db.transaction((tx) => tx.delete(study).where(eq(study.id, studyId)).run())
        } catch (error) {
          if (moved) renameSync(tree, dir)
          rmSync(trashed, { recursive: true, force: true })
          throw error
        }
        rmSync(envFileOf(deps.home, studyId), { force: true })
        events.publish(studyId, null)
        for (const sessionId of sessionIds) {
          deps
            .deleteSession(sessionId, { dir: sessionDir })
            .catch((error: unknown) =>
              console.error(
                `[study] could not delete the claude session ${sessionId} of ${studyId}: ${(error as Error).message}`,
              ),
            )
        }
        return undefined
      } finally {
        if (states.get(studyId) === removing) states.delete(studyId)
      }
    },

    async cleanPlaygrounds() {
      const stale = db
        .select({ id: study.id })
        .from(study)
        .where(lt(study.lastActiveAt, new Date(Date.now() - STALE_MS)))
        .orderBy(asc(study.lastActiveAt))
        .all()
      const failures: string[] = []
      for (const { id } of stale) {
        // turn の claude が Playground を使っているので、次の日に回す。
        if (decide(states.get(id), 'clean') !== 'go') continue
        const { promise: done, resolve } = Promise.withResolvers<void>()
        const cleaning: Occupancy = { kind: 'cleaning', done }
        states.set(id, cleaning)
        try {
          // 前の Study を消す await の間に、発言や shell で動いたかもしれない。
          if (!isStale(db.select().from(study).where(eq(study.id, id)).get())) continue
          const env = join(dirOf(id), 'env')
          const { removed, failures: failed } = await removePlayground(
            { rootsDir: env, removeDir: env, studyId: id },
            { tools: deps.tools ?? deps.runner.tools(), run: deps.runner.run },
          )
          if (removed) {
            db.update(study).set({ playgroundRemovedAt: new Date() }).where(eq(study.id, id)).run()
          }
          failed.push(...(await cleanPrototypes(dirOf(id), deps.runner.run)))
          if (failed.length > 0) failures.push(`${id}: ${failed.join(', ')}`)
        } catch (error) {
          failures.push(`${id}: ${(error as Error).message}`)
        } finally {
          if (states.get(id) === cleaning) states.delete(id)
          resolve()
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not clean up the Playgrounds: ${failures.join('; ')}`)
      }
    },

    /** 呼び手の transaction の中で、Playground が変わっている間は断り、他は Study を動いたことにする。 */
    touchForShell(tx: Pick<Db, 'update'>, studyId: string): Refusal | undefined {
      const verdict = decide(states.get(studyId), 'shell')
      if (verdict !== 'go') return refusal(studyId, verdict)
      touch(tx, studyId, new Date())
      return undefined
    },

    answerPermission: settle,

    running: (studyId: string) => liveTurn(states.get(studyId)) !== undefined,

    watch(studyId: string, signal: AbortSignal | undefined): AsyncGenerator<StudyWatchEvent> {
      // 既定の 100 を超えると古い event から捨てられ、delta が抜けると途中の文が壊れる。
      const subscribed = events.subscribe(studyId, {
        ...(signal && { signal }),
        maxBufferedEvents: Number.POSITIVE_INFINITY,
      })
      // 購読と snapshot の間に await を挟まないので、snapshot の後の event を落とさず、二重にもしない。
      const last = db
        .select({ id: max(studyMessage.id) })
        .from(studyMessage)
        .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
        .where(eq(studyConversation.studyId, studyId))
        .get()
      const turn = liveTurn(states.get(studyId))
      const snapshot: StudyWatchEvent = {
        type: 'snapshot',
        running: turn !== undefined,
        lastMessageId: last?.id ?? null,
        partialText: turn?.partialText ?? '',
      }
      return (async function* () {
        yield snapshot
        for await (const event of subscribed) {
          if (event === null) return
          yield event
        }
      })()
    },

    stop() {
      tutors.stop()
    },
  }
}
