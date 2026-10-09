import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { terminalSession } from '@monica/workbench/schema'
import {
  createWorkbenchLedger,
  router as workbenchRouter,
  migrations as workbenchMigrations,
} from '@monica/workbench/server'
import { startFakePtyd, tempHome, untilSettled } from '@monica/workbench/testing'
import { createRouterClient } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { isIssue } from './copy.ts'
import { fakeGhq } from './fake-ghq.ts'
import { startFakeGitHub } from './fake-github.ts'
import { parseRef } from './ref.ts'
import { bench, issue } from './schema.ts'
import { createTaskLedger, migrations, nameAgentSession, router } from './server.ts'

const cleanups: (() => void)[] = []
export const onCleanup = (cleanup: () => void) => cleanups.push(cleanup)

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
}

export async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code: string; message: string; data?: unknown }
  }
  throw new Error('expected the call to fail')
}

export function setup() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const m of [workbenchMigrations, migrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
  }
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())
  const notifications: { title: string; body: string; terminalSessionId: string }[] = []
  const workbenchLedger = createWorkbenchLedger({
    db,
    home,
    ptydPath: join(home, 'no-ptyd'),
    notify: (notification) => notifications.push(notification),
    nameAgentSession,
    unread: () => {},
  })
  onCleanup(() => workbenchLedger.stop())
  const workbenchClient = createRouterClient(workbenchRouter, {
    context: { db, workbenchLedger },
  })
  const github = startFakeGitHub()
  onCleanup(() => github.stop())
  const scratch = mkdtempSync(join(tmpdir(), 'monica-task-'))
  onCleanup(() => rmSync(scratch, { recursive: true, force: true }))
  const ghq = fakeGhq(scratch)

  function boot() {
    const taskLedger = createTaskLedger({
      db,
      workbenchLedger,
      github: github.client,
      home,
      ghq: ghq.client,
    })
    onCleanup(() => taskLedger.stop())
    const client = createRouterClient(router, { context: { db, taskLedger } })
    return { taskLedger, client }
  }

  const booted = boot()
  function restartTaskLedger() {
    booted.taskLedger.stop()
    return boot()
  }

  // in-place の Bench は checkout が在れば git を呼ばない。
  async function openBench(
    ref: string,
    title = 'Ship it',
    { worktree = false } = {},
  ): Promise<string> {
    github.issue(ref, { title })
    await booted.client.track({ ref })
    if (!worktree) mkdirSync(ghq.checkout(parseRef(ref).repo), { recursive: true })
    await booted.client.run({ ref, inPlace: !worktree })
    return db
      .select({ runspaceId: bench.runspaceId })
      .from(bench)
      .innerJoin(issue, eq(issue.id, bench.taskIssueId))
      .where(isIssue(parseRef(ref)))
      .get()!.runspaceId
  }

  function openTab(runspaceId: string): string {
    return db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId })).terminalSessionId
  }

  // procedure で開く Runspace は Tab を 1 つ持って生まれるので、Bench の外の Tab は Runspace ごと開く。
  async function openTabOutsideBench(): Promise<string> {
    const { tab } = await workbenchClient.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
    return tab.terminalSessionId
  }

  const settled = (terminalSessionId: string) =>
    untilSettled(() => workbenchClient.terminalSession.list(), terminalSessionId)

  // shell の Exit は ptyd から非同期に届くので、Backend が行を exited にするまで待つ。
  async function exit(terminalSessionId: string) {
    await settled(terminalSessionId)
    ptyd.exit(terminalSessionId, 0)
    while (
      db.select().from(terminalSession).where(eq(terminalSession.id, terminalSessionId)).get()
        ?.status !== 'exited'
    ) {
      await Bun.sleep(5)
    }
  }

  // agent の報告は workbench の procedure に渡し、Backend と同じ経路で Agent Session を作る。
  function hook(
    terminalSessionId: string,
    sessionId: string,
    hookEventName: string,
    fields: object = {},
  ) {
    return workbenchClient.agentSession.recordHook({
      terminalSessionId,
      payload: {
        session_id: sessionId,
        cwd: '/work/app',
        hook_event_name: hookEventName,
        ...fields,
      },
    })
  }

  return {
    db,
    workbenchLedger,
    workbenchClient,
    ptyd,
    github,
    ghq,
    home,
    notifications,
    ...booted,
    restartTaskLedger,
    openBench,
    openTab,
    openTabOutsideBench,
    settled,
    exit,
    hook,
  }
}
