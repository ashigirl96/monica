import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getDefaultStore } from 'jotai'

// toast は画面の外にあるので、出した文言だけを記録する。
const toasts: { type: 'info' | 'error'; message: string }[] = []
const ui = await import('@monica/ui')
await mock.module('@monica/ui', () => ({
  ...ui,
  pushInfoToast: (message: string) => {
    toasts.push({ type: 'info', message })
  },
  pushErrorToast: (message: string) => {
    toasts.push({ type: 'error', message })
  },
}))

const { cleanUp, setup } = await import('../testing.ts')
const { git } = await import('../fake-ghq.ts')
const { closeTaskOfBench, closingRunspaceIdsAtom, refusedReasonsAtom } =
  await import('./close-bench.ts')

afterEach(() => {
  mock.restore()
  cleanUp()
  toasts.length = 0
})

const ref = 'acme/app#12'

type Fixture = Awaited<ReturnType<typeof tracked>>

// Run は Bench の Tab の claude から購読で生まれるので、track の前に start する。
async function tracked() {
  const fixture = setup()
  fixture.taskLedger.start()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.client.track({ ref })
  return { ...fixture, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

async function benchOf({ client }: Pick<Fixture, 'client'>) {
  const [bench] = await client.bench.list()
  return bench!
}

// in-place の Bench は checkout が在れば git を呼ばない。
function runInPlace({ client, ghq }: Pick<Fixture, 'client' | 'ghq'>) {
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  return client.run({ ref, inPlace: true })
}

test('the Task of a Bench no guard stops is closed, with a toast that it closed and one per warning', async () => {
  const fixture = await tracked()
  const { client, github } = fixture
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)
  github.fail('acme/app')

  await closeTaskOfBench(client, runspaceId)

  expect(await client.bench.list()).toEqual([])
  expect((await client.list({ closed: true })).tasks).toMatchObject([{ ref }])
  expect(toasts).toEqual([
    { type: 'info', message: `closed ${ref}` },
    {
      type: 'info',
      message: expect.stringContaining(`warning: could not sync ${ref} from GitHub`),
    },
  ])
})

test('a refused close leaves the Bench and tells why on one line, in the words of the CLI', async () => {
  const fixture = await tracked()
  fixture.ghq.origin('acme/app')
  const { client, cwd } = fixture
  const { terminalSessionId } = await client.run({ ref })
  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })
  writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)

  await closeTaskOfBench(client, runspaceId)

  expect(await client.bench.list()).toMatchObject([{ runspaceId, ref }])
  expect(toasts).toEqual([
    {
      type: 'error',
      message: `CLOSE_REFUSED: ${ref} stays open: claude s-1 is a live Run (waiting); the worktree ${cwd} has uncommitted changes`,
    },
  ])
})

// claude の居ない worktree の Bench に uncommitted な変更を置き、guard だけが止める形にする。
async function refusedByUncommittedChanges() {
  const fixture = await tracked()
  fixture.ghq.origin('acme/app')
  await fixture.client.run({ ref })
  writeFileSync(join(fixture.cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)
  await closeTaskOfBench(fixture.client, runspaceId)
  toasts.length = 0
  return { ...fixture, runspaceId }
}

const reasonsOf = (runspaceId: string) => getDefaultStore().get(refusedReasonsAtom).get(runspaceId)

test('a forced close of a refused Bench passes force and forgets the reasons', async () => {
  const { client, runspaceId, cwd } = await refusedByUncommittedChanges()

  await closeTaskOfBench(client, runspaceId, { force: true })

  expect(await client.bench.list()).toEqual([])
  expect((await client.list({ closed: true })).tasks).toMatchObject([{ ref }])
  expect(existsSync(cwd)).toBe(false)
  expect(reasonsOf(runspaceId)).toBeUndefined()
  expect(toasts).toEqual([{ type: 'info', message: `closed ${ref}` }])
})

test('a forced close that fails tells why on one line and keeps the reasons', async () => {
  const { client, ghq, runspaceId, cwd } = await refusedByUncommittedChanges()
  git(ghq.checkout('acme/app'), 'worktree', 'lock', cwd)

  await closeTaskOfBench(client, runspaceId, { force: true })

  expect(await client.bench.list()).toMatchObject([{ runspaceId, ref }])
  expect(reasonsOf(runspaceId)).toEqual([{ kind: 'uncommitted_changes', worktree: cwd }])
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*git worktree remove failed/),
    },
  ])
  expect(toasts[0]!.message).not.toContain('\n')
})

test('a close run anew forgets the reasons it remembered before, even when it fails for another cause', async () => {
  const { client, ghq, runspaceId, cwd } = await refusedByUncommittedChanges()
  rmSync(join(cwd, 'draft.txt'))
  git(ghq.checkout('acme/app'), 'worktree', 'lock', cwd)

  await closeTaskOfBench(client, runspaceId)

  expect(await client.bench.list()).toMatchObject([{ runspaceId, ref }])
  expect(reasonsOf(runspaceId)).toBeUndefined()
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*git worktree remove failed/),
    },
  ])
})

test('a Bench that closed stays among those closing, so it shows no Close anyway until it is gone', async () => {
  const fixture = await tracked()
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)

  await closeTaskOfBench(fixture.client, runspaceId)

  expect(getDefaultStore().get(closingRunspaceIdsAtom).has(runspaceId)).toBe(true)
})

test('a Bench still preparing is not closed', async () => {
  const fixture = await tracked()
  const { client, ghq } = fixture
  const asked = Promise.withResolvers<void>()
  const cloned = Promise.withResolvers<void>()
  spyOn(ghq.client, 'get').mockImplementation(() => {
    asked.resolve()
    return cloned.promise
  })
  const running = client.run({ ref, inPlace: true })
  await asked.promise
  const { runspaceId, setupState } = await benchOf(fixture)
  expect(setupState).toBe('preparing')

  await closeTaskOfBench(client, runspaceId)

  expect(toasts).toEqual([])
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  cloned.resolve()
  await running
  expect(await client.bench.list()).toMatchObject([{ runspaceId, setupState: 'ready' }])
})

test('a second call while the close runs, or after the Bench is gone, closes nothing more', async () => {
  const fixture = await tracked()
  const { client } = fixture
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)

  await Promise.all([closeTaskOfBench(client, runspaceId), closeTaskOfBench(client, runspaceId)])
  await closeTaskOfBench(client, runspaceId)

  expect(toasts).toEqual([{ type: 'info', message: `closed ${ref}` }])
})
