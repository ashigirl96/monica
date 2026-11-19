import { afterEach, expect, mock, test } from 'bun:test'
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
  return {
    ...fixture,
    deps,
    cwd: join(fixture.ghq.checkout('acme/app'), '.claude/worktrees/issue-12'),
  }
}

// claude --worktree が作る worktree の代わり。
async function runInWorktree(fixture: Fixture) {
  const { terminalSessionId } = await fixture.client.run({ ref })
  fixture.ghq.claudeWorktree('acme/app', 12)
  await fixture.exit(terminalSessionId)
}

// worktree を git から切り離し、close の git を guard の外で失敗させる。
function breakGitLink(worktree: string) {
  writeFileSync(join(worktree, '.git'), 'gitdir: /nonexistent\n')
}

async function benchOf({ client }: Pick<Fixture, 'client'>) {
  const [bench] = await client.bench.list()
  return bench!
}

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

// in-place の Bench は checkout が在れば git を呼ばない。
// webview は Bench の最後の Tab を閉じるとすぐ close を呼ぶので、Run の claude の Exit はまだ記録されていない。
async function runInPlace({ client, ghq, hook, closeTab }: Fixture) {
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  const { terminalSessionId } = await client.run({ ref, inPlace: true })
  await hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })
  await closeTab(terminalSessionId)
}

test('a Bench emptied of its last Tab is closed once, without force, right away, and shows nothing while it closes', async () => {
  const fixture = await tracked()
  const { client, deps, github } = fixture
  await runInPlace(fixture)
  const { runspaceId } = await benchOf(fixture)
  github.fail('acme/app')
  const closeCalls = recordCloses(fixture)

  const closing = emptied(deps, runspaceId)
  await emptied(deps, runspaceId)
  expect(await shown(fixture, runspaceId)).toBeNull()
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
  fixture.ghq.claudeWorktree('acme/app', 12)
  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })
  writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)

  await emptied(deps, runspaceId)

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
  await runInWorktree(fixture)
  writeFileSync(join(fixture.cwd, 'draft.txt'), 'draft\n')
  const { runspaceId } = await benchOf(fixture)
  await emptied(fixture.deps, runspaceId)
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
  const { deps, runspaceId, cwd } = fixture
  breakGitLink(cwd)

  await press(deps, runspaceId)
  await press(deps, runspaceId)

  expect(benchCloseOf(deps.store, runspaceId)).toEqual({
    phase: 'refused',
    reasons: [{ kind: 'uncommitted_changes', worktree: cwd }],
  })
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*not a git repository/),
    },
  ])
  expect(toasts[0]!.message).not.toContain('\n')
})

test('a close run anew forgets the reasons it remembered before, even when it fails for another cause, and offers Close', async () => {
  const fixture = await refusedByUncommittedChanges()
  const { deps, runspaceId, cwd } = fixture
  rmSync(join(cwd, 'draft.txt'))
  breakGitLink(cwd)

  await emptied(deps, runspaceId)

  expect(await shown(fixture, runspaceId)).toEqual({ reasons: null, label: 'Close' })
  expect(toasts).toEqual([
    {
      type: 'error',
      message: expect.stringMatching(/^could not close .*not a git repository/),
    },
  ])
})

test('a Bench with no reasons, as after its last Tab moved out or a restart, offers Close, which closes without force once and turns into Close anyway when refused', async () => {
  const fixture = await tracked()
  fixture.ghq.origin('acme/app')
  const { cwd, deps } = fixture
  await runInWorktree(fixture)
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
