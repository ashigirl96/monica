import { join } from 'node:path'

import { tab } from '@monica/workbench/schema'

import type { Files } from './fake-ghq.ts'
import { bench } from './schema.ts'
import { setup } from './testing.ts'

export const ref = 'acme/app#12'

export type Fixture = Awaited<ReturnType<typeof tracked>>

// Run は Bench の Tab の claude から購読で生まれるので、track の前に start する。
export async function tracked({ origin }: { origin?: Files } = {}) {
  const fixture = setup()
  if (origin !== undefined) fixture.ghq.origin('acme/app', origin)
  fixture.taskLedger.start()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.client.track({ ref })
  return { ...fixture, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

export async function withWorktreeBench(files: Files = {}) {
  const fixture = await tracked({ origin: files })
  const { terminalSessionId } = await fixture.client.run({ ref })
  await startedAndEnded(fixture, terminalSessionId)
  return { ...fixture, claudeTab: terminalSessionId, runspaceId: benchOf(fixture)!.runspaceId }
}

// run が起こした claude が Run にならないうちは、起動中の予約が強制でない close と次の run を断る。
export async function startedAndEnded(
  { hook }: Pick<Fixture, 'hook'>,
  terminalSessionId: string,
  sessionId = 's-0',
) {
  await hook(terminalSessionId, sessionId, 'SessionStart', { source: 'startup' })
  await hook(terminalSessionId, sessionId, 'SessionEnd', { reason: 'exit' })
}

export function benchOf({ db }: Pick<Fixture, 'db'>) {
  return db.select().from(bench).get()
}

export function hasBranch(checkout: string, branch: string): boolean {
  return Bun.spawnSync(
    ['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { env: process.env },
  ).success
}

export function terminated({ ptyd }: Pick<Fixture, 'ptyd'>) {
  return ptyd.receivedAll((op) => op.op === 'terminate').map((op) => op.session_id)
}

// close は commit したら返り、Terminate はその後で ptyd に届く。
export async function terminatedAfterClose({ ptyd }: Pick<Fixture, 'ptyd'>, count: number) {
  const ops = await ptyd.receivedAtLeast(count, (op) => op.op === 'terminate')
  return ops.map((op) => op.session_id)
}

export function tabsOf({ db }: Pick<Fixture, 'db'>) {
  return db.select({ terminalSessionId: tab.terminalSessionId }).from(tab).all()
}

export async function until(done: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await Bun.sleep(25)
  }
  throw new Error('timed out waiting')
}
