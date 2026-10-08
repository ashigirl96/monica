import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
const { closeTaskOfBench } = await import('./close-bench.ts')

afterEach(() => {
  cleanUp()
  toasts.length = 0
})

const ref = 'acme/app#12'

type Fixture = Awaited<ReturnType<typeof tracked>>

// Run は Bench の Tab の claude から購読で生まれるので、track の前に start する。
async function tracked(setupScript?: string) {
  const fixture = setup()
  fixture.ghq.origin(
    'acme/app',
    setupScript ? { '.monica/setup.sh': { content: setupScript, mode: 0o755 } } : {},
  )
  fixture.taskLedger.start()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.client.track({ ref })
  return { ...fixture, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

async function benchOf({ client }: Pick<Fixture, 'client'>) {
  const [bench] = await client.bench.list()
  return bench!
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await Bun.sleep(25)
  }
  throw new Error('timed out waiting')
}

test('the Task of a Bench no guard stops is closed, with a toast that it closed and one per warning', async () => {
  const fixture = await tracked()
  const { client, github } = fixture
  await client.run({ ref })
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

test('a Bench still preparing is not closed', async () => {
  const fixture = await tracked(
    '#!/bin/sh\ntouch .started\nwhile [ ! -e .release ]; do sleep 0.02; done\n',
  )
  const { client, cwd } = fixture
  const running = client.run({ ref })
  await until(() => existsSync(join(cwd, '.started')))
  const { runspaceId, setupState } = await benchOf(fixture)
  expect(setupState).toBe('preparing')

  await closeTaskOfBench(client, runspaceId)

  expect(toasts).toEqual([])
  writeFileSync(join(cwd, '.release'), '')
  await running
  expect(await client.bench.list()).toMatchObject([{ runspaceId, setupState: 'ready' }])
})

test('a second call while the close runs, or after the Bench is gone, closes nothing more', async () => {
  const fixture = await tracked()
  const { client } = fixture
  await client.run({ ref })
  const { runspaceId } = await benchOf(fixture)

  await Promise.all([closeTaskOfBench(client, runspaceId), closeTaskOfBench(client, runspaceId)])
  await closeTaskOfBench(client, runspaceId)

  expect(toasts).toEqual([{ type: 'info', message: `closed ${ref}` }])
})
