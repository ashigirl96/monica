import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createStore } from 'jotai'

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
const { benchCloseOf, benchClosesAtom, disarm, emptied, forgetGone, press, shownOf } =
  await import('./bench-close.ts')

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
  await fixture.track(ref)
  const deps = { store: createStore(), client: fixture.client }
  return { ...fixture, deps, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

async function benchOf({ client }: Pick<Fixture, 'client'>) {
  const [bench] = await client.bench.list()
  return bench!
}

// 準備中かは今の Bench の行から読む。
async function shown(fixture: Fixture, runspaceId: string) {
  const bench = await benchOf(fixture)
  return shownOf(benchCloseOf(fixture.deps.store, runspaceId), bench)
}

// oRPC の client は呼ぶたびに Proxy を返し spyOn が効かないので、close を包んで渡した入力を記録する。
function recordCloses(fixture: Fixture) {
  const calls: unknown[] = []
  const { client } = fixture
  fixture.deps.client = new Proxy(client, {
    get: (target, key) =>
      key === 'close'
        ? (input: Parameters<typeof client.close>[0]) => {
            calls.push(input)
            return target.close(input)
          }
        : Reflect.get(target, key),
  })
  return calls
}

const recorded = Promise.resolve()

// in-place の Bench は checkout が在れば git を呼ばない。
// webview は Bench の最後の Tab の Exit を Backend が記録してから close を呼ぶので、run の claude の Tab は先に終わらせる。
async function runInPlace({ client, ghq, exit }: Pick<Fixture, 'client' | 'ghq' | 'exit'>) {
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  await exit((await client.run({ ref, inPlace: true })).terminalSessionId)
}

test('a Bench emptied of its last Tab is closed once, without force, only once the exit is recorded, and shows nothing until then and while it closes', async () => {
  const fixture = await tracked()
  const { client, deps, github } = fixture
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)
  github.fail('acme/app')
  const exitRecorded = Promise.withResolvers<void>()
  const closeCalls = recordCloses(fixture)

  const closing = emptied(deps, runspaceId, exitRecorded.promise)
  const again = emptied(deps, runspaceId, recorded)
  await again
  expect(await shown(fixture, runspaceId)).toBeNull()
  expect(closeCalls).toEqual([])
  exitRecorded.resolve()
  await closing

  expect(closeCalls).toEqual([{ ref, force: undefined }])
  expect(await client.bench.list()).toEqual([])
  expect((await client.list({ closed: true })).tasks).toMatchObject([{ ref }])
  expect(benchCloseOf(deps.store, runspaceId)).toEqual({ phase: 'closing', reasons: null })
  expect(toasts).toEqual([
    { type: 'info', message: `closed ${ref}` },
    {
      type: 'info',
      message: expect.stringContaining(`warning: could not sync ${ref} from GitHub`),
    },
  ])
})

test('a refused close leaves the Bench with its reasons and Close anyway, and tells why on one line, in the words of the CLI', async () => {
  const fixture = await tracked()
  fixture.ghq.origin('acme/app')
  const { client, cwd, deps } = fixture
  const { terminalSessionId } = await client.run({ ref })
  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })
  writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)

  await emptied(deps, runspaceId, recorded)

  expect(await client.bench.list()).toMatchObject([{ runspaceId, ref }])
  expect(await shown(fixture, runspaceId)).toEqual({
    reasons: ['claude s-1 is a live Run (waiting)', `the worktree ${cwd} has uncommitted changes`],
    label: 'Close anyway',
  })
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
  await fixture.exit((await fixture.client.run({ ref })).terminalSessionId)
  writeFileSync(join(fixture.cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)
  await emptied(fixture.deps, runspaceId, recorded)
  toasts.length = 0
  return { ...fixture, runspaceId }
}

test('Close anyway asks once more, goes back when the focus leaves, and closes with force on the second press', async () => {
  const fixture = await refusedByUncommittedChanges()
  const { client, deps, runspaceId, cwd } = fixture
  const closeCalls = recordCloses(fixture)

  await press(deps, runspaceId)
  expect(await shown(fixture, runspaceId)).toMatchObject({
    label: 'Click again to discard changes',
  })
  disarm(deps.store, runspaceId)
  expect(await shown(fixture, runspaceId)).toMatchObject({ label: 'Close anyway' })
  await press(deps, runspaceId)
  expect(closeCalls).toEqual([])
  await press(deps, runspaceId)

  expect(closeCalls).toEqual([{ ref, force: true }])
  expect(await client.bench.list()).toEqual([])
  expect(existsSync(cwd)).toBe(false)
  expect(benchCloseOf(deps.store, runspaceId)).toEqual({ phase: 'closing', reasons: null })
  expect(toasts).toEqual([{ type: 'info', message: `closed ${ref}` }])
})

test('a forced close that fails tells why on one line and keeps the reasons and Close anyway', async () => {
  const fixture = await refusedByUncommittedChanges()
  const { deps, ghq, runspaceId, cwd } = fixture
  git(ghq.checkout('acme/app'), 'worktree', 'lock', cwd)

  await press(deps, runspaceId)
  await press(deps, runspaceId)

  expect(benchCloseOf(deps.store, runspaceId)).toEqual({
    phase: 'refused',
    reasons: [{ kind: 'uncommitted_changes', worktree: cwd }],
  })
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*git worktree remove failed/),
    },
  ])
  expect(toasts[0]!.message).not.toContain('\n')
})

test('a close run anew forgets the reasons it remembered before, even when it fails for another cause, and offers Close', async () => {
  const fixture = await refusedByUncommittedChanges()
  const { deps, ghq, runspaceId, cwd } = fixture
  rmSync(join(cwd, 'draft.txt'))
  git(ghq.checkout('acme/app'), 'worktree', 'lock', cwd)

  await emptied(deps, runspaceId, recorded)

  expect(await shown(fixture, runspaceId)).toEqual({ reasons: null, label: 'Close' })
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*git worktree remove failed/),
    },
  ])
})

test('a Bench with no reasons, as after its last Tab moved out or a restart, offers Close, which closes without force once and turns into Close anyway when refused', async () => {
  const fixture = await tracked()
  fixture.ghq.origin('acme/app')
  const { client, cwd, deps } = fixture
  await fixture.exit((await client.run({ ref })).terminalSessionId)
  writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)
  const closeCalls = recordCloses(fixture)
  expect(await shown(fixture, runspaceId)).toEqual({ reasons: null, label: 'Close' })

  await press(deps, runspaceId)

  expect(closeCalls).toEqual([{ ref, force: undefined }])
  expect(await shown(fixture, runspaceId)).toEqual({
    reasons: [`the worktree ${cwd} has uncommitted changes`],
    label: 'Close anyway',
  })
})

test('a Bench with no reasons that closes without force is gone with its state once it leaves the list', async () => {
  const fixture = await tracked()
  const { client, deps } = fixture
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)

  await press(deps, runspaceId)
  expect(benchCloseOf(deps.store, runspaceId)).toMatchObject({ phase: 'closing' })
  forgetGone(deps.store, new Map((await client.bench.list()).map((b) => [b.runspaceId, b])))

  expect(deps.store.get(benchClosesAtom).size).toBe(0)
  expect(toasts).toEqual([{ type: 'info', message: `closed ${ref}` }])
})

test('a Bench still preparing shows nothing and is not closed, keeps the reasons it remembered, and offers Close once ready', async () => {
  const fixture = await tracked()
  const { client, deps, ghq } = fixture
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
  const closeCalls = recordCloses(fixture)
  // 準備中の Bench が理由を覚えている場面は公開の操作では作れないので、状態を直に置く。
  const reasons = [{ kind: 'uncommitted_changes' as const, worktree: '/w' }]
  deps.store.set(benchClosesAtom, new Map([[runspaceId, { phase: 'refused' as const, reasons }]]))

  expect(await shown(fixture, runspaceId)).toBeNull()
  await emptied(deps, runspaceId, recorded)
  expect(benchCloseOf(deps.store, runspaceId)).toEqual({ phase: 'refused', reasons })
  deps.store.set(benchClosesAtom, new Map())
  await press(deps, runspaceId)

  expect(closeCalls).toEqual([])
  expect(toasts).toEqual([])
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  cloned.resolve()
  await running
  expect(await shown(fixture, runspaceId)).toEqual({ reasons: null, label: 'Close' })
})
