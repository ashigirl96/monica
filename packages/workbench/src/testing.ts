import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { Atom, Store } from 'jotai'

import { startFakePtyd, tempHome, untilSettled } from './fake-ptyd.ts'
import { createWorkbenchLedger, migrations, router } from './server.ts'
import type { Badge, NotificationDeps } from './workbench.ts'

const cleanups: (() => void)[] = []

export function onCleanup(cleanup: () => void) {
  cleanups.push(cleanup)
}

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
}

export function stderrLines() {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  onCleanup(() => spy.mockRestore())
  return () => spy.mock.calls.map((args) => args.join(' '))
}

export function setup({
  notify = () => {},
  nameAgentSession = () => null,
  badge = () => {},
}: Partial<NotificationDeps & { badge: Badge }> = {}) {
  const home = tempHome(onCleanup)
  const ptyd = startFakePtyd(home)
  onCleanup(() => ptyd.stop())

  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })

  function boot() {
    const workbenchLedger = createWorkbenchLedger({
      db,
      home,
      ptydPath: join(home, 'no-ptyd'),
      notify,
      nameAgentSession,
      badge,
    })
    onCleanup(() => workbenchLedger.stop())
    const client = createRouterClient(router, { context: { db, workbenchLedger } })
    return { workbenchLedger, client }
  }

  const booted = boot()
  function restartBackend() {
    booted.workbenchLedger.stop()
    return boot()
  }

  const settled = (terminalSessionId: string) =>
    untilSettled(() => booted.client.terminalSession.list(), terminalSessionId)

  return { home, ptyd, db, ...booted, restartBackend, settled }
}

export function until<T>(store: Store, atom: Atom<T>, done: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const check = () => {
      const value = store.get(atom)
      if (!done(value)) return
      unsubscribe()
      resolve(value)
    }
    const unsubscribe = store.sub(atom, check)
    check()
  })
}

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args])
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

// CI には git の user が無いので、commit に author を渡す。
function initRepo(root: string, dir: string) {
  git(root, 'init', '--initial-branch=main', dir)
  git(
    dir,
    '-c',
    'user.name=monica',
    '-c',
    'user.email=monica@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  )
}

// worktree は Bench と同じく ghq の外に置く。
export function ghqCheckout(repo: string) {
  const root = mkdtempSync(join(tmpdir(), 'monica-git-'))
  onCleanup(() => rmSync(root, { recursive: true, force: true }))
  const checkout = join(root, 'ghq', 'github.com', repo)
  const worktree = join(root, 'worktrees', repo, 'issue-1')
  mkdirSync(dirname(checkout), { recursive: true })
  initRepo(root, checkout)
  git(checkout, 'worktree', 'add', '-b', 'issue-1', worktree)
  const elsewhere = join(root, 'elsewhere')
  initRepo(root, elsewhere)
  return { root, checkout, worktree, elsewhere }
}
