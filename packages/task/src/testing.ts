import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { runspace, tab, terminalSession } from '@tania/workbench/schema'
import {
  createWorkbench,
  router as workbenchRouter,
  migrations as workbenchMigrations,
} from '@tania/workbench/server'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { isIssue } from './copy.ts'
import { fakeGhq } from './fake-ghq.ts'
import { startFakeGitHub } from './fake-github.ts'
import { parseRef } from './ref.ts'
import { bench, issue } from './schema.ts'
import { createTask, migrations, nameAgentSession, router } from './server.ts'

const cleanups: (() => void)[] = []

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

export type PtydCall =
  | { op: 'start'; terminalSessionId: string; rows: number; cols: number }
  | { op: 'write'; terminalSessionId: string; data: string }
  | { op: 'terminate'; terminalSessionId: string }

export function setup() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const m of [workbenchMigrations, migrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
  }
  const notifications: { title: string; body: string }[] = []
  const workbench = createWorkbench({
    db,
    home: '/nonexistent',
    ptydPath: '/nonexistent',
    notify: (notification) => notifications.push(notification),
    nameAgentSession,
  })
  // ptyd が無いので、Workbench が ptyd に送る口は呼ばれた順に記録するだけにする。
  const ptyd: PtydCall[] = []
  spyOn(workbench, 'ready').mockResolvedValue()
  spyOn(workbench, 'startTerminalSession').mockImplementation(async (terminalSessionId, size) => {
    ptyd.push({ op: 'start', terminalSessionId, ...size })
  })
  spyOn(workbench, 'writeTerminalSession').mockImplementation(async (terminalSessionId, data) => {
    ptyd.push({ op: 'write', terminalSessionId, data })
  })
  spyOn(workbench, 'terminateTerminalSessions').mockImplementation(async (ids) => {
    for (const terminalSessionId of ids) ptyd.push({ op: 'terminate', terminalSessionId })
  })
  const workbenchClient = createRouterClient(workbenchRouter, { context: { db, workbench } })
  const github = startFakeGitHub()
  cleanups.push(() => github.stop())
  const scratch = mkdtempSync(join(tmpdir(), 'tania-task-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  const home = join(scratch, 'home')
  mkdirSync(home)
  const ghq = fakeGhq(scratch)

  function boot() {
    const task = createTask({ db, workbench, github: github.client, home, ghq: ghq.client })
    cleanups.push(() => task.stop())
    const client = createRouterClient(router, { context: { db, task } })
    return { task, client }
  }

  const booted = boot()
  function restartTask() {
    booted.task.stop()
    return boot()
  }

  async function openBench(ref: string, title = 'Ship it'): Promise<string> {
    github.issue(ref, { title })
    await booted.client.track({ ref })
    await booted.client.run({ ref })
    return db
      .select({ runspaceId: bench.runspaceId })
      .from(bench)
      .innerJoin(issue, eq(issue.id, bench.taskIssueId))
      .where(isIssue(parseRef(ref)))
      .get()!.runspaceId
  }

  let opened = 0
  // ptyd が無いので、Tab と live な Terminal Session の行は fixture として書く。
  function openTab(runspaceId: string): string {
    const terminalSessionId = `ts-${++opened}`
    db.insert(terminalSession)
      .values({
        id: terminalSessionId,
        cwd: '/work',
        shell: '/bin/zsh',
        status: 'running',
        createdAt: new Date(),
      })
      .run()
    db.insert(tab)
      .values({ id: `tab-${opened}`, runspaceId, cwd: '/work', sortOrder: 0, terminalSessionId })
      .run()
    return terminalSessionId
  }

  function plainRunspace(): string {
    const id = `rs-plain-${++opened}`
    db.insert(runspace).values({ id, cwd: '/work', sortOrder: opened }).run()
    return id
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
    workbench,
    workbenchClient,
    ptyd,
    github,
    ghq,
    home,
    notifications,
    ...booted,
    restartTask,
    openBench,
    openTab,
    plainRunspace,
    hook,
  }
}
