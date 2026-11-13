import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  deleteSession as sdkDeleteSession,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { localIso } from '@monica/ui/local-time'
import { EventPublisher, ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, like, lt, max, sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { STALE_MS } from './activity.ts'
import { listArtifacts, readArtifact, resolveArtifact } from './artifact.ts'
import type { AskUser } from './box.ts'
import {
  createTutorClaudes,
  envFileOf,
  type Query,
  readModels,
  type TurnEnd,
  type TutorEvent,
  type TutorRequest,
} from './claude.ts'
import { cleanPrototypes, createRunner, removePlayground, type Tools } from './cleanup.ts'
import {
  type Choice,
  type Model,
  repoKey,
  type StudyMessage,
  type StudyWatchEvent,
} from './contract.ts'
import { playgroundEnv } from './playground.ts'
import { study, studyConversation, studyMessage, studyRepo } from './schema.ts'
import { shellZdotdirOf, writeShellFiles } from './shell.ts'

export type Db = BunSQLiteDatabase

export type StudyLedger = {
  /** monica study shell の zsh が読む shim を書く。 */
  start(): void
  /** 持っている claude と Playground の掃除の子 process すべての group を同期に止める。 */
  stop(): void
  /** STALE_MS より前に最後の活動があった Study の Playground を消す。 */
  cleanPlaygrounds(): Promise<void>
  /** 最後の行から 1 時間たった続いている会話を振り返らずに終え、振り返りの途中で止まった会話は振り返らせて終える。 */
  endIdleConversations(): Promise<void>
  /** 捨て場の Study のうち行の無いものを、Playground ごと消す。 */
  sweepTrash(): Promise<void>
}

const IDLE_MS = 60 * 60_000
const NO_SDK_RECORD_SUMMARY = 'SDK の記録が消えていたので、振り返らずに終えた'

type Turn = {
  partialText: string
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

const READ_LIMIT_BYTES = 64 * 1024

// Tutor が置いた FIFO や大きな file で list を止めないよう、通常の file の頭だけを読む。
function readOrEmpty(path: string): string {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return ''
  }
  try {
    if (!fstatSync(fd).isFile()) return ''
    const buffer = Buffer.alloc(READ_LIMIT_BYTES)
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, READ_LIMIT_BYTES, 0))
  } finally {
    closeSync(fd)
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

const isStale = (row: { lastActiveAt: Date } | undefined) =>
  row !== undefined && row.lastActiveAt.getTime() < Date.now() - STALE_MS

const isRepo = (repo: string) => eq(sql`lower(${studyRepo.repo})`, repoKey(repo))

function makeLedger(deps: {
  db: Db
  home: string
  claudePath?: string | undefined
  query?: Query
  tutorsDir?: string | undefined
  openInEditor: (path: string) => Promise<void>
  tools?: Tools
  deleteSession?: typeof sdkDeleteSession
}) {
  const { db, home } = deps
  const studiesDir = join(home, 'studies')
  const trashDir = join(home, 'trash', 'studies')
  const query = deps.query ?? sdkQuery
  // null は Study が消えた印で、watch はそれまでの event を流し終えてから閉じる。
  const events = new EventPublisher<Record<string, StudyWatchEvent | null>>()
  const turns = new Map<string, Turn>()
  let models: Promise<Model[]> | undefined
  const waiting = new Map<number, (allowed: boolean) => void>()
  const cleaning = new Map<string, Promise<void>>()
  const removing = new Set<string>()
  const runner = createRunner()
  const dirOf = (id: string) => join(studiesDir, id)
  const shellZdotdir = shellZdotdirOf(home)
  const tutors = createTutorClaudes({
    home,
    tutorDir: deps.tutorsDir ?? join(import.meta.dir, '../tutors'),
    claudePath: deps.claudePath,
    query,
    studyDir: dirOf,
    askUser: (studyId) => askUserFor(studyId),
  })

  // claude は Backend と一緒に居なくなったので、前の Backend で待っていた許可には答える相手が無い。
  db.update(studyMessage)
    .set({ permissionState: 'denied' })
    .where(eq(studyMessage.permissionState, 'pending'))
    .run()

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

  /** 会話を終え、claude を閉じる。振り返らずに終えた時は、その理由を log.md の末尾にも書く。 */
  function finish(studyId: string, conversationId: string, ending: string | null, logged: boolean) {
    const ended = db
      .update(studyConversation)
      .set({ endedAt: new Date(), summary: ending })
      .where(and(eq(studyConversation.id, conversationId), isNull(studyConversation.endedAt)))
      .returning({ id: studyConversation.id })
      .get()
    if (ended) events.publish(studyId, { type: 'conversation-ended', conversationId })
    void tutors.close(studyId)
    if (!logged || ending === null) return
    try {
      appendLine(join(dirOf(studyId), 'log.md'), `- ${localIso(new Date())} ${ending}`)
    } catch (error) {
      console.error(`[study] could not write log.md of ${studyId}: ${(error as Error).message}`)
    }
  }

  function finishAfter(
    studyId: string,
    conversationId: string,
    turn: Turn,
    end: Exclude<TurnEnd, { kind: 'stopped' }>,
  ) {
    if (end.kind === 'session-lost') {
      finish(studyId, conversationId, NO_SDK_RECORD_SUMMARY, true)
    } else if (turn.reflection && end.kind === 'failed') {
      finish(
        studyId,
        conversationId,
        `振り返りの turn が失敗した: ${firstNonEmptyLine(end.error)}`,
        true,
      )
    } else if (turn.reflection && end.kind === 'answered') {
      finish(studyId, conversationId, firstNonEmptyLine(end.lastText), false)
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
    if (end.kind !== 'stopped') finishAfter(studyId, conversationId, turn, end)
    touch(db, studyId, new Date())
    turns.delete(studyId)
    events.publish(studyId, {
      type: 'turn-ended',
      error: end.kind === 'answered' ? null : end.error,
    })
    turn.end()
  }

  function refuseWhileChangingPlayground(studyId: string) {
    if (removing.has(studyId)) {
      throw new ORPCError('CONFLICT', { message: `${studyId} is being removed` })
    }
    if (cleaning.has(studyId)) {
      throw new ORPCError('CONFLICT', {
        message: `the Playground of ${studyId} is being cleaned up`,
      })
    }
  }

  /** turn の印を await の前に確かめて付ける。 */
  function takeTurn(studyId: string, reflection: boolean): Turn {
    if (turns.has(studyId)) {
      throw new ORPCError('CONFLICT', { message: `a turn is already running in ${studyId}` })
    }
    refuseWhileChangingPlayground(studyId)
    const { promise, resolve } = Promise.withResolvers<void>()
    const turn = { partialText: '', reflection, ended: promise, end: resolve }
    turns.set(studyId, turn)
    return turn
  }

  /** turn の印を付けたまま claude に答えさせる。claude の席が無いか prepare が投げれば、印を外して断る。 */
  function reply<T>(
    studyId: string,
    turn: Turn,
    request: TutorRequest,
    prepare: () => {
      conversation: { id: string; startedAt: Date; sessionId: string | null }
      value: T
    },
  ): T {
    let replied
    try {
      replied = tutors.reply(studyId, request, () => {
        const { conversation, value } = prepare()
        return {
          conversation,
          value: { value, conversationId: conversation.id },
          onEvent: (event: TutorEvent) => record(studyId, conversation.id, turn, event),
        }
      })
    } catch (error) {
      turns.delete(studyId)
      turn.end()
      throw error
    }
    if (replied === 'full') {
      turns.delete(studyId)
      turn.end()
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: 'every Tutor claude is in a turn; try again when one ends',
      })
    }
    void runTurn(studyId, replied.value.conversationId, turn, replied.ended)
    return replied.value.value
  }

  /** ユーザーの発言を書いて turn を始め、turn の終わりを待たずに書いた行を返す。 */
  function startTurn(studyId: string, text: string, choice: Choice): StudyMessage {
    mustExist(studyId)
    const turn = takeTurn(studyId, false)
    const now = new Date()
    const written = reply(studyId, turn, { kind: 'say', text, choice }, () => {
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
    events.publish(studyId, { type: 'turn-started', conversationId: written.conversation.id })
    const message = toMessage(written.row)
    events.publish(studyId, { type: 'message', message })
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
      turn.end()
      return
    }
    const row = reply(studyId, turn, { kind: 'reflect' }, () => ({
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
    events.publish(studyId, { type: 'turn-started', conversationId })
    if (row) events.publish(studyId, { type: 'message', message: toMessage(row) })
  }

  /** 会話を振り返らずに終える。止めた turn が SDK の記録の無さで先に終えていれば、finish は何も書き換えない。 */
  function endWithoutReflection(studyId: string, conversationId: string) {
    if (turns.has(studyId)) {
      throw new ORPCError('CONFLICT', { message: `a turn is already running in ${studyId}` })
    }
    finish(studyId, conversationId, null, false)
  }

  /** pending の許可を断って turn を止め、その終わりを待ってから、振り返りの turn を始めるか振り返らずに終える。 */
  async function endConversation(
    studyId: string,
    conversationId: string,
    idle: boolean,
    reflect: boolean,
  ) {
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
    if (turn) {
      for (const row of pending) settle(row.id, false)
      await tutors.interrupt(studyId)
      await turn.ended
    }
    // 止めた turn の Tutor の行で最後の行が新しくなるので、止めた後は無発言を見直さない。
    if (reflect) startReflection(studyId, conversationId, idle && !turn)
    else endWithoutReflection(studyId, conversationId)
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
          playgroundRemoved:
            row.playgroundRemovedAt !== null && row.playgroundRemovedAt > row.lastActiveAt,
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

    send(id: string, text: string, choice: Choice) {
      return { message: startTurn(id, text, choice) }
    },

    models(): Promise<Model[]> {
      models ??= readModels({ query, claudePath: deps.claudePath }).catch((error: unknown) => {
        models = undefined
        throw error
      })
      return models
    },

    async remove(id: string): Promise<Record<string, never>> {
      mustExist(id)
      if (removing.has(id)) throw new ORPCError('CONFLICT', { message: `${id} is being removed` })
      removing.add(id)
      try {
        const pending = db
          .select({ id: studyMessage.id })
          .from(studyMessage)
          .innerJoin(studyConversation, eq(studyMessage.conversationId, studyConversation.id))
          .where(
            and(eq(studyConversation.studyId, id), eq(studyMessage.permissionState, 'pending')),
          )
          .all()
        for (const row of pending) settle(row.id, false)
        // 止めた claude が消した dir に書き戻さず、turn-ended が行の消えた後に流れないようにする。
        await Promise.all([tutors.close(id), turns.get(id)?.ended, cleaning.get(id)])
        const sessionIds = db
          .select({ sessionId: studyConversation.sessionId })
          .from(studyConversation)
          .where(eq(studyConversation.studyId, id))
          .all()
          .flatMap((row) => (row.sessionId ? [row.sessionId] : []))
        const dir = dirOf(id)
        const trashed = join(trashDir, id)
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
          db.transaction((tx) => tx.delete(study).where(eq(study.id, id)).run())
        } catch (error) {
          if (moved) renameSync(tree, dir)
          rmSync(trashed, { recursive: true, force: true })
          throw error
        }
        rmSync(envFileOf(home, id), { force: true })
        events.publish(id, null)
        const deleteSession = deps.deleteSession ?? sdkDeleteSession
        for (const sessionId of sessionIds) {
          deleteSession(sessionId, { dir: sessionDir }).catch((error: unknown) =>
            console.error(
              `[study] could not delete the claude session ${sessionId} of ${id}: ${(error as Error).message}`,
            ),
          )
        }
        return {}
      } finally {
        removing.delete(id)
      }
    },

    async endConversation(id: string, reflect: boolean): Promise<{ conversationId: string }> {
      mustExist(id)
      const ongoing = ongoingOf(id)
      if (!ongoing)
        throw new ORPCError('NOT_FOUND', { message: `no ongoing Study Conversation in ${id}` })
      await endConversation(id, ongoing.id, false, reflect)
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
        for await (const event of subscribed) {
          if (event === null) return
          yield event
        }
      })()
    },

    shell(prefix: string) {
      const studyId = db.transaction((tx) => {
        const found = tx
          .select({ id: study.id })
          .from(study)
          .where(like(study.id, `study-${prefix}%`))
          .orderBy(asc(study.id))
          .all()
        if (found.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: `no Study's id starts with ${prefix}` })
        }
        if (found.length > 1) {
          const candidates = found
            .map(({ id }) => `${id} (${missionLine(dirOf(id)) ?? 'no Mission yet'})`)
            .join(', ')
          throw new ORPCError('BAD_REQUEST', {
            message: `${prefix} matches ${found.length} Studies: ${candidates}; give more of the id`,
          })
        }
        const { id } = found[0]!
        refuseWhileChangingPlayground(id)
        touch(tx, id, new Date())
        return id
      })
      return {
        studyId,
        dir: dirOf(studyId),
        env: playgroundEnv(dirOf(studyId), studyId),
        zdotdir: shellZdotdir,
      }
    },
  }

  const ledger: StudyLedger = {
    start() {
      writeShellFiles(home)
      // 捨て場へ移してから行を消すまでの間に、前の Backend が止まった Study を戻す。
      for (const name of existsSync(trashDir) ? readdirSync(trashDir) : []) {
        if (!exists(name)) continue
        const trashed = join(trashDir, name)
        try {
          if (existsSync(join(trashed, 'tree'))) renameSync(join(trashed, 'tree'), dirOf(name))
          rmSync(trashed, { recursive: true, force: true })
        } catch (error) {
          console.error(`[study] could not put ${trashed} back: ${(error as Error).message}`)
        }
      }
    },
    stop() {
      tutors.stop()
      runner.killAll()
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
        if (turns.has(id) || removing.has(id)) continue
        const { promise: cleaned, resolve: endCleaning } = Promise.withResolvers<void>()
        cleaning.set(id, cleaned)
        try {
          // 前の Study を消す await の間に、発言や shell で動いたかもしれない。
          if (!isStale(db.select().from(study).where(eq(study.id, id)).get())) continue
          const env = join(dirOf(id), 'env')
          const { removed, failures: failed } = await removePlayground(
            { rootsDir: env, removeDir: env, studyId: id },
            { tools: deps.tools ?? runner.tools(), run: runner.run },
          )
          if (removed) {
            db.update(study).set({ playgroundRemovedAt: new Date() }).where(eq(study.id, id)).run()
          }
          failed.push(...(await cleanPrototypes(dirOf(id), runner.run)))
          if (failed.length > 0) failures.push(`${id}: ${failed.join(', ')}`)
        } catch (error) {
          failures.push(`${id}: ${(error as Error).message}`)
        } finally {
          cleaning.delete(id)
          endCleaning()
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not clean up the Playgrounds: ${failures.join('; ')}`)
      }
    },
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
          // 振り返りの行があるのは、振り返りの途中で Backend が止まった会話。
          const reflect = hasReflection(conversation.id)
          await endConversation(conversation.studyId, conversation.id, true, reflect)
        } catch (error) {
          if (
            error instanceof ORPCError &&
            (error.code === 'CONFLICT' || error.code === 'TOO_MANY_REQUESTS')
          ) {
            continue
          }
          failures.push(`${conversation.id}: ${(error as Error).message}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not end the idle Study Conversations: ${failures.join('; ')}`)
      }
    },
    async sweepTrash() {
      const failures: string[] = []
      for (const name of existsSync(trashDir) ? readdirSync(trashDir).toSorted() : []) {
        // 消している途中か、start() で戻す前の Study。
        if (exists(name)) continue
        const trashed = join(trashDir, name)
        const tree = join(trashed, 'tree')
        try {
          const { failures: failed, dockerSkipped } = await removePlayground(
            { rootsDir: join(tree, 'env'), removeDir: tree, studyId: name },
            { tools: deps.tools ?? runner.tools(), run: runner.run },
          )
          if (failed.length > 0) failures.push(`${name}: ${failed.join(', ')}`)
          // docker に届かなかった時は、次の回に docker の物を消す印として残す。
          else if (!dockerSkipped) rmSync(trashed, { recursive: true, force: true })
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`could not delete the trashed Studies: ${failures.join('; ')}`)
      }
    },
  }
  return { ledger, procedures }
}

// study は job を import しないので、createJobLedger の systemJobs と同じ構造の素のオブジェクトで返す。
export function systemJobs(studyLedger: StudyLedger) {
  return [
    {
      name: 'study.env-cleanup',
      every: 24 * 60 * 60_000,
      run: () => studyLedger.cleanPlaygrounds(),
    },
    {
      name: 'study.conversation-end',
      every: 5 * 60_000,
      run: () => studyLedger.endIdleConversations(),
    },
    { name: 'study.trash-sweep', every: 10 * 60_000, run: () => studyLedger.sweepTrash() },
  ]
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
