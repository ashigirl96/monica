import { Database } from 'bun:sqlite'
import { join } from 'node:path'

import { createRouterClient, os } from '@orpc/server'
import {
  createJobLedger,
  migrations as jobMigrations,
  router as jobRouter,
} from '@tania/job/server'
import { issue, issueBlocker, task as taskTable } from '@tania/task/schema'
import {
  createTaskLedger,
  type Ghq,
  migrations as taskMigrations,
  router as taskRouter,
} from '@tania/task/server'
import {
  createWorkbenchLedger,
  migrations as workbenchMigrations,
  router as workbenchRouter,
} from '@tania/workbench/server'
import { startFakePtyd, tempHome, untilSettled } from '@tania/workbench/testing'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import type { Client } from './backend.ts'
import { runCli } from './program.ts'

// CI に ghq は無く、手元では本物の repo を clone してしまう。
const noGhq: Ghq = {
  root: () => Promise.reject(new Error('ghq root failed: no ghq in the CLI tests')),
  get: () => Promise.reject(new Error('ghq get failed: no ghq in the CLI tests')),
}

const cleanups: (() => void)[] = []
const onCleanup = (cleanup: () => void) => cleanups.push(cleanup)

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
}

export function inMemoryBackend({ home, ghq = noGhq }: { home?: string; ghq?: Ghq } = {}) {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  for (const m of [workbenchMigrations, taskMigrations, jobMigrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
  }
  const ptydHome = tempHome(onCleanup)
  const ptyd = startFakePtyd(ptydHome)
  onCleanup(() => ptyd.stop())
  const workbenchLedger = createWorkbenchLedger({
    db,
    home: ptydHome,
    ptydPath: join(ptydHome, 'no-ptyd'),
    notify() {},
    nameAgentSession: () => null,
  })
  onCleanup(() => workbenchLedger.stop())
  // CLI のテストは GitHub に届かせない。
  const taskLedger = createTaskLedger({
    db,
    workbenchLedger,
    home: home ?? ptydHome,
    ghq,
    github: {
      url: 'http://127.0.0.1:9/graphql',
      token: () => Promise.reject(new Error('`gh auth token` failed: not logged in')),
    },
  })
  const jobLedger = createJobLedger({
    db,
    systemJobs: [
      { name: 'task.sync', every: 5 * 60_000, run: () => taskLedger.syncInBackground() },
      {
        name: 'task.setup-log-cleanup',
        every: 24 * 60 * 60_000,
        run: () => taskLedger.cleanSetupLogs(),
      },
    ],
  })
  onCleanup(() => jobLedger.stop())
  const context = { db, workbenchLedger, taskLedger, jobLedger }
  return {
    sqlite,
    db,
    router: os
      .$context<typeof context>()
      .router({ workbench: workbenchRouter, task: taskRouter, job: jobRouter }),
    context,
  }
}

// procedure で開く Runspace は Tab を 1 つ持って生まれるので、Bench の外の Tab は Runspace ごと開く。
export async function openTabOutsideBench(client: Client): Promise<string> {
  const { tab } = await client.workbench.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
  await untilSettled(() => client.workbench.terminalSession.list(), tab.terminalSessionId)
  return tab.terminalSessionId
}

export function backendWithTasks() {
  const backend = inMemoryBackend()
  const { db } = backend
  const syncedAt = new Date(0)
  const [blocker, open, closed] = db
    .insert(issue)
    .values([
      { repo: 'acme/lib', number: 3, title: 'Upstream fix', state: 'open', syncedAt },
      { repo: 'acme/app', number: 12, title: 'Ship it', state: 'open', syncedAt },
      { repo: 'acme/app', number: 1, title: 'Shipped', state: 'closed', syncedAt },
    ])
    .returning()
    .all()
  db.insert(issueBlocker).values({ issueId: open!.id, blockerId: blocker!.id }).run()
  db.insert(taskTable)
    .values([
      { issueId: open!.id, trackedAt: new Date(1) },
      { issueId: closed!.id, trackedAt: new Date(2), closedAt: new Date(3) },
    ])
    .run()
  const client = createRouterClient(backend.router, { context: backend.context })
  return () => client
}

export async function tania(
  argv: string[],
  connect: () => Client | null,
  { terminalSessionId }: { terminalSessionId?: string } = {},
) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    connect,
    terminalSessionId,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { code, stdout, stderr }
}
