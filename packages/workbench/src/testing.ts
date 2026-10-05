import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { startFakePtyd, tempHome, untilSettled } from './fake-ptyd.ts'
import { createWorkbench, migrations, router } from './server.ts'
import type { NotificationDeps } from './workbench.ts'

const cleanups: (() => void)[] = []

export function onCleanup(cleanup: () => void) {
  cleanups.push(cleanup)
}

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
}

export function setup({
  notify = () => {},
  nameAgentSession = () => null,
}: Partial<NotificationDeps> = {}) {
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())

  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })

  function boot() {
    const workbench = createWorkbench({
      db,
      home,
      ptydPath: join(home, 'no-ptyd'),
      notify,
      nameAgentSession,
    })
    onCleanup(() => workbench.stop())
    const client = createRouterClient(router, { context: { db, workbench } })
    return { workbench, client }
  }

  const booted = boot()
  function restartBackend() {
    booted.workbench.stop()
    return boot()
  }

  const settled = (terminalSessionId: string) =>
    untilSettled(() => booted.client.terminalSession.list(), terminalSessionId)

  return { home, ptyd, db, ...booted, restartBackend, settled }
}

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args])
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

// CI には git の user が無いので、commit に author を渡す。
export function linkedWorktree({ repo: name, branch }: { repo: string; branch: string }) {
  const root = mkdtempSync(join(tmpdir(), 'tania-git-'))
  onCleanup(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, name)
  const worktree = join(root, 'worktree')
  git(root, 'init', '--initial-branch=main', repo)
  git(
    repo,
    '-c',
    'user.name=tania',
    '-c',
    'user.email=tania@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  )
  git(repo, 'worktree', 'add', '-b', branch, worktree)
  return { root, repo, worktree }
}
