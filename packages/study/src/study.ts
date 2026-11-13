import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  deleteSession as sdkDeleteSession,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, like, sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { listArtifacts, readArtifact, resolveArtifact } from './artifact.ts'
import { createTutorClaudes, type Query, readModels } from './claude.ts'
import { createRunner, removePlayground, type Tools } from './cleanup.ts'
import { type Choice, type Model, repoKey, type StudyWatchEvent } from './contract.ts'
import { createStudyLifecycle, firstNonEmptyLine, isRefusal, toMessage } from './lifecycle.ts'
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
  const runner = createRunner()
  const dirOf = (id: string) => join(studiesDir, id)
  const shellZdotdir = shellZdotdirOf(home)
  const query = deps.query ?? sdkQuery
  let models: Promise<Model[]> | undefined
  const lifecycle = createStudyLifecycle({
    db,
    home,
    dirOf,
    trashDir,
    tutors: (askUser) =>
      createTutorClaudes({
        home,
        tutorDir: deps.tutorsDir ?? join(import.meta.dir, '../tutors'),
        claudePath: deps.claudePath,
        query,
        studyDir: dirOf,
        askUser,
      }),
    runner,
    tools: deps.tools,
    deleteSession: deps.deleteSession ?? sdkDeleteSession,
  })

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
        running: lifecycle.running(id),
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
      mustExist(id)
      const message = lifecycle.send(id, text, choice)
      return isRefusal(message) ? message : { message }
    },

    models(): Promise<Model[]> {
      models ??= readModels({ query, claudePath: deps.claudePath }).catch((error: unknown) => {
        models = undefined
        throw error
      })
      return models
    },

    async remove(id: string) {
      mustExist(id)
      return (await lifecycle.remove(id)) ?? {}
    },

    async endConversation(id: string, reflect: boolean) {
      mustExist(id)
      const ongoing = ongoingOf(id)
      if (!ongoing)
        throw new ORPCError('NOT_FOUND', { message: `no ongoing Study Conversation in ${id}` })
      return (await lifecycle.end(id, ongoing.id, reflect)) ?? { conversationId: ongoing.id }
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

    answerPermission(id: number, allow: boolean) {
      const message = lifecycle.answerPermission(id, allow)
      if (!message) throw new ORPCError('NOT_FOUND', { message: `no permission row ${id}` })
      return message
    },

    watch(id: string, signal: AbortSignal | undefined): AsyncGenerator<StudyWatchEvent> {
      mustExist(id)
      return lifecycle.watch(id, signal)
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
        return lifecycle.touchForShell(tx, id) ?? id
      })
      if (isRefusal(studyId)) return studyId
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
      lifecycle.stop()
      runner.killAll()
    },
    cleanPlaygrounds: () => lifecycle.cleanPlaygrounds(),
    endIdleConversations: () => lifecycle.endIdleConversations(),
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
