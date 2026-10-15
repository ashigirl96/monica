import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { runspace, tab } from '@monica/workbench/schema'

import { commit, git } from './fake-ghq.ts'
import { bench, issue, task } from './schema.ts'
import { cleanUp, failure, onCleanup, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

const ref = 'acme/app#12'
const executable = 0o755

type Fixture = ReturnType<typeof setup>

async function tracked(script: string | null = '#!/bin/sh\npwd > .setup-ran\n', mode = executable) {
  const fixture = setup()
  fixture.ghq.origin(
    'acme/app',
    script === null ? {} : { '.monica/setup.sh': { content: script, mode } },
  )
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  return { ...fixture, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await done()) return
    await Bun.sleep(25)
  }
  throw new Error('timed out waiting')
}

function setupLog({ home }: Fixture) {
  return join(home, 'logs/setup/acme/app/issue-12.log')
}

function attempts(cwd: string) {
  return readFileSync(join(cwd, '.attempts'), 'utf8').split('\n').filter(Boolean).length
}

test("run makes a worktree on a new branch issue-n from origin's default branch, runs its setup, and then returns the cwd", async () => {
  const { ghq, db, client, cwd } = await tracked()

  const output = await client.run({ ref })

  expect(output).toMatchObject({ ref, cwd, mode: 'worktree', benchCreated: true, warnings: [] })
  expect(ghq.gets).toEqual(['acme/app'])
  expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue-12')
  expect(git(cwd, 'rev-parse', 'HEAD')).toBe(
    git(ghq.checkout('acme/app'), 'rev-parse', 'origin/main'),
  )
  expect(readFileSync(join(cwd, '.setup-ran'), 'utf8').trim()).toBe(
    git(cwd, 'rev-parse', '--show-toplevel'),
  )
  const { id: runspaceId } = db.select().from(runspace).get()!
  expect(await client.bench.list()).toEqual([
    { runspaceId, ref, title: 'Ship it', setupState: 'ready' },
  ])
  expect((await client.list({})).tasks).toMatchObject([
    { ref, cwd, displayState: { state: 'ended' } },
  ])
})

test("run makes an empty CLAUDE.local.md in the checkout, ignored by git, and links the worktree's to it before the setup", async () => {
  const { ghq, client, cwd } = await tracked('#!/bin/sh\ntest -L CLAUDE.local.md\n')

  expect(await client.run({ ref })).toMatchObject({ warnings: [] })

  const checkout = ghq.checkout('acme/app')
  expect(readFileSync(join(checkout, 'CLAUDE.local.md'), 'utf8')).toBe('')
  expect(realpathSync(join(cwd, 'CLAUDE.local.md'))).toBe(
    realpathSync(join(checkout, 'CLAUDE.local.md')),
  )
  expect(git(checkout, 'status', '--porcelain')).toBe('')
  expect(git(cwd, 'status', '--porcelain')).toBe('')
})

test('run keeps the CLAUDE.local.md already in the checkout and does not exclude it again', async () => {
  const { ghq, client, cwd } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  writeFileSync(join(checkout, 'CLAUDE.local.md'), 'lesson\n')
  writeFileSync(join(checkout, '.git/info/exclude'), 'CLAUDE.local.md\n')

  await client.run({ ref })

  expect(readFileSync(join(cwd, 'CLAUDE.local.md'), 'utf8')).toBe('lesson\n')
  expect(readFileSync(join(checkout, '.git/info/exclude'), 'utf8')).toBe('CLAUDE.local.md\n')
})

test('run warns when the .gitignore of the Repo keeps CLAUDE.local.md from being ignored', async () => {
  const fixture = setup()
  fixture.ghq.origin('acme/app', { '.gitignore': { content: '!CLAUDE.local.md\n' } })
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)

  const output = await fixture.client.run({ ref })

  expect(output.warnings).toEqual([
    expect.stringContaining('CLAUDE.local.md is not ignored by git'),
  ])
})

test('run excludes CLAUDE.local.md when only the branch of the checkout ignores it, not that of the worktree', async () => {
  const fixture = setup()
  fixture.ghq.origin('acme/app', { '.gitignore': { content: 'CLAUDE.local.md\n' } })
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  fixture.ghq.clone('acme/app')
  const checkout = fixture.ghq.checkout('acme/app')
  git(checkout, 'switch', '--quiet', '-c', 'issue-12')
  commit(checkout, { '.gitignore': { content: '' } }, 'unignore')
  git(checkout, 'switch', '--quiet', 'main')
  const cwd = join(fixture.home, 'worktrees/acme/app/issue-12')

  expect(await fixture.client.run({ ref })).toMatchObject({ warnings: [] })

  expect(git(cwd, 'status', '--porcelain')).toBe('')
})

test('run excludes CLAUDE.local.md when only the branch of the worktree ignores it, not that of the checkout', async () => {
  const { ghq, client } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  git(checkout, 'switch', '--quiet', '-c', 'issue-12')
  commit(checkout, { '.gitignore': { content: 'CLAUDE.local.md\n' } }, 'ignore')
  git(checkout, 'switch', '--quiet', 'main')

  expect(await client.run({ ref })).toMatchObject({ warnings: [] })

  expect(git(checkout, 'status', '--porcelain')).not.toContain('CLAUDE.local.md')
})

test('run warns and still readies the Bench when it cannot make CLAUDE.local.md in the checkout', async () => {
  const { ghq, client } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  chmodSync(checkout, 0o555)
  onCleanup(() => chmodSync(checkout, 0o755))

  const output = await client.run({ ref })

  expect(output.warnings).toEqual([
    expect.stringContaining('could not share CLAUDE.local.md with the checkout'),
  ])
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
})

test('run excludes CLAUDE.local.md even when the checkout hides untracked files from git status', async () => {
  const { ghq, client, cwd } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  git(checkout, 'config', 'status.showUntrackedFiles', 'no')

  await client.run({ ref })

  expect(git(cwd, 'check-ignore', 'CLAUDE.local.md')).toBe('CLAUDE.local.md')
})

test('run leaves a CLAUDE.local.md the worktree already has in place of the link', async () => {
  const fixture = setup()
  fixture.ghq.origin('acme/app', { 'CLAUDE.local.md': { content: 'tracked\n' } })
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  const cwd = join(fixture.home, 'worktrees/acme/app/issue-12')

  expect(await fixture.client.run({ ref })).toMatchObject({ warnings: [] })

  expect(lstatSync(join(cwd, 'CLAUDE.local.md')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(cwd, 'CLAUDE.local.md'), 'utf8')).toBe('tracked\n')
})

test('the Bench is listed while it prepares, and a second run waits for the same preparation, then is refused without a Tab once the first opens its own', async () => {
  const { db, ghq, client, cwd } = await tracked(null)
  const root = await ghq.client.root()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  const roots = spyOn(ghq.client, 'root').mockImplementation(() => {
    asked.resolve()
    return answer.promise
  })

  const first = client.run({ ref })
  await asked.promise

  expect(await client.bench.list()).toMatchObject([{ ref, setupState: 'preparing' }])
  expect(db.select().from(runspace).all()).toMatchObject([{ cwd, owned: true }])
  expect((await client.list({})).tasks).toMatchObject([{ displayState: { state: 'preparing' } }])

  const second = failure(client.run({ ref }))
  answer.resolve(root)

  expect(await first).toMatchObject({ benchCreated: true })
  expect(await second).toMatchObject({
    code: 'CONFLICT',
    message: `${ref} has a Run being started; to add an agent alongside, open a Tab in its Bench and run claude there`,
  })
  expect(roots).toHaveBeenCalledTimes(1)
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
  expect(db.select().from(tab).all()).toHaveLength(1)
})

test('run checks out a branch issue-n that already exists, without cloning a Repo that is cloned', async () => {
  const { ghq, client, cwd } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  git(checkout, 'switch', '--quiet', '-c', 'issue-12')
  const started = commit(checkout, { 'started.txt': { content: 'wip\n' } }, 'start')
  git(checkout, 'switch', '--quiet', 'main')

  await client.run({ ref })

  expect(ghq.gets).toEqual([])
  expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue-12')
  expect(git(cwd, 'rev-parse', 'HEAD')).toBe(started)
})

test.each([
  ['exits non-zero', '#!/bin/sh\necho broken >&2\nexit 3\n', executable, 'exit 3'],
  ['is not executable', '#!/bin/sh\necho broken\n', 0o644, 'spawn failed: EACCES'],
])(
  'a setup that %s fails the run with the reason and the log path',
  async (_, script, mode, reason) => {
    const fixture = await tracked(script, mode)
    const { client } = fixture

    const error = await failure(client.run({ ref }))

    expect(error.code).toBe('PRECONDITION_FAILED')
    expect(error.message).toContain(reason)
    expect(error.message).toContain(setupLog(fixture))
    expect(readFileSync(setupLog(fixture), 'utf8')).toContain(reason)
    expect(await client.bench.list()).toMatchObject([{ setupState: 'failed' }])
    expect((await client.list({})).tasks).toMatchObject([
      { displayState: { state: 'setup_failed' } },
    ])
  },
)

test('a setup still running after 600 seconds fails, its process group getting SIGTERM and 2 seconds before SIGKILL', async () => {
  const fixture = await tracked(
    [
      '#!/bin/sh',
      `sh -c 'trap "sleep 0.3; touch .cleaned; exit 0" TERM; touch .trapping; while :; do sleep 0.05; done' &`,
      `sh -c 'trap "" TERM; echo $$ > .stubborn; exec sleep 30' &`,
      'sleep 30',
    ].join('\n'),
  )
  const { client, cwd } = fixture
  const realSleep = Bun.sleep
  let loops = 0
  const looped: { count: number; resolve: () => void }[] = []
  spyOn(Bun, 'sleep').mockImplementation(async (ms) => {
    if (ms === 50) {
      loops++
      for (const waiter of looped.filter((w) => loops >= w.count)) waiter.resolve()
    }
    return realSleep(ms)
  })
  const graceLoops = (more: number) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    looped.push({ count: loops + more, resolve })
    return promise
  }
  const realSetTimeout = globalThis.setTimeout
  let fireTimeout: (() => void) | undefined
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== 600_000) return realSetTimeout(callback, ms)
    fireTimeout = callback
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout)

  const running = failure(client.run({ ref }))
  await until(
    () =>
      existsSync(join(cwd, '.stubborn')) &&
      readFileSync(join(cwd, '.stubborn'), 'utf8') !== '' &&
      existsSync(join(cwd, '.trapping')) &&
      fireTimeout !== undefined,
  )
  const stubborn = Number(readFileSync(join(cwd, '.stubborn'), 'utf8'))
  // 猶予は Date.now() の締め切りで待つので、SIGTERM の前に時計を止め、猶予の残りを手で進める。
  const t0 = Date.now()
  setSystemTime(t0)
  fireTimeout!()
  await until(() => existsSync(join(cwd, '.cleaned')))
  setSystemTime(t0 + 1_999)
  await graceLoops(2)
  expect(isAlive(stubborn)).toBe(true)
  setSystemTime(t0 + 2_000)
  const error = await running

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain('timed out after 600s')
  await until(() => !isAlive(stubborn))
  expect(await client.bench.list()).toMatchObject([{ setupState: 'failed' }])
})

test('run after a failure redoes only the setup in the worktree it made', async () => {
  const { ghq, client, cwd } = await tracked(
    '#!/bin/sh\necho attempt >> .attempts\ntest -e "$(git rev-parse --git-common-dir)/setup-ok"\n',
  )
  await failure(client.run({ ref }))
  writeFileSync(join(ghq.checkout('acme/app'), '.git/setup-ok'), '')

  const output = await client.run({ ref })

  expect(output).toMatchObject({ cwd, benchCreated: false, warnings: [] })
  expect(attempts(cwd)).toBe(2)
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
})

test('run after a failure redoes the setup in the worktree it made even when the repo was renamed since', async () => {
  const { db, ghq, client, cwd } = await tracked(
    '#!/bin/sh\ntest -e "$(git rev-parse --git-common-dir)/setup-ok"\n',
  )
  await failure(client.run({ ref }))
  writeFileSync(join(ghq.checkout('acme/app'), '.git/setup-ok'), '')
  db.update(issue).set({ repo: 'acme/renamed' }).run()

  const output = await client.run({ ref: 'acme/renamed#12' })

  expect(output).toMatchObject({ ref: 'acme/renamed#12', cwd, benchCreated: false })
  expect(ghq.gets).toEqual(['acme/app'])
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
})

test('run refuses to make again a worktree that is gone when the repo was renamed since', async () => {
  const { db, ghq, client, cwd } = await tracked('#!/bin/sh\nexit 1\n')
  await failure(client.run({ ref }))
  rmSync(cwd, { recursive: true, force: true })
  db.update(issue).set({ repo: 'acme/renamed' }).run()

  const error = await failure(client.run({ ref: 'acme/renamed#12' }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain('renamed')
  expect(ghq.gets).toEqual(['acme/app'])
  expect(existsSync(cwd)).toBe(false)
})

test('run after a failure makes the worktree again when it is gone', async () => {
  const { ghq, client, cwd } = await tracked(
    '#!/bin/sh\ntest -e "$(git rev-parse --git-common-dir)/setup-ok"\n',
  )
  await failure(client.run({ ref }))
  rmSync(cwd, { recursive: true, force: true })
  writeFileSync(join(ghq.checkout('acme/app'), '.git/setup-ok'), '')

  await client.run({ ref })

  expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue-12')
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
})

test('run makes again a worktree that is gone without dropping the registration of another missing worktree', async () => {
  const { home, ghq, client, cwd } = await tracked(
    '#!/bin/sh\ntest -e "$(git rev-parse --git-common-dir)/setup-ok"\n',
  )
  await failure(client.run({ ref }))
  const checkout = ghq.checkout('acme/app')
  const another = join(realpathSync(home), 'elsewhere/app')
  git(checkout, 'worktree', 'add', '--quiet', '-b', 'elsewhere', another)
  rmSync(another, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  writeFileSync(join(checkout, '.git/setup-ok'), '')

  await client.run({ ref })

  expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(`worktree ${another}\n`)
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
})

test("run --in-place opens the Bench on the Repo's checkout, cloning it, and runs no setup", async () => {
  const { home, ghq, client, exit } = await tracked('#!/bin/sh\nexit 1\n')
  const checkout = ghq.checkout('acme/app')

  const output = await client.run({ ref, inPlace: true })
  await exit(output.terminalSessionId)

  expect(output).toMatchObject({
    ref,
    cwd: checkout,
    mode: 'in_place',
    benchCreated: true,
    warnings: [],
  })
  expect(ghq.gets).toEqual(['acme/app'])
  expect(existsSync(join(home, 'worktrees'))).toBe(false)
  expect(readFileSync(join(checkout, 'CLAUDE.local.md'), 'utf8')).toBe('')
  expect(git(checkout, 'status', '--porcelain')).toBe('')
  expect(await client.bench.list()).toMatchObject([{ setupState: 'ready' }])
  expect(await client.run({ ref })).toMatchObject({ cwd: checkout, benchCreated: false })
})

test('run --in-place fails when ghq clones the renamed repo away from the checkout of the Bench', async () => {
  const { ghq, github, client } = await tracked(null)
  const checkout = ghq.checkout('acme/app')
  spyOn(ghq.client, 'get').mockRejectedValueOnce(new Error('network is down'))
  await failure(client.run({ ref, inPlace: true }))
  expect(await client.bench.list()).toMatchObject([{ setupState: 'failed' }])
  github.renameRepo('acme/app', 'acme/renamed')
  ghq.origin('acme/renamed')

  const error = await failure(client.run({ ref: 'acme/renamed#12', inPlace: true }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain(`did not clone it to ${checkout}`)
})

test('task.changes signals the Task when run opens its Bench and again when the Bench is prepared', async () => {
  const { db, ghq, client, taskLedger } = await tracked(null)
  const benchStates: (string | null)[] = []
  taskLedger.events.subscribe('change', (change) => {
    if (change.type !== 'task' || change.ref !== ref) return
    benchStates.push(
      db.select({ setupState: bench.setupState }).from(bench).get()?.setupState ?? null,
    )
  })
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<void>()
  spyOn(ghq.client, 'get').mockImplementation(async (repo) => {
    asked.resolve()
    await answer.promise
    ghq.clone(repo)
  })

  const running = client.run({ ref, inPlace: true })
  await asked.promise

  expect(benchStates).toContain('preparing')
  expect(benchStates).not.toContain('ready')

  answer.resolve()
  await running

  expect(benchStates).toContain('ready')
})

test('run --in-place refuses a Bench that is a worktree', async () => {
  const { client } = await tracked(null)
  await client.run({ ref })

  const error = await failure(client.run({ ref, inPlace: true }))

  expect(error.code).toBe('BAD_REQUEST')
})

test("run warns and starts from the local origin's default branch when it cannot fetch", async () => {
  const { ghq, client, cwd } = await tracked(null)
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  git(checkout, 'remote', 'set-url', 'origin', join(checkout, 'gone'))

  const output = await client.run({ ref })

  expect(output.warnings).toEqual([expect.stringContaining('could not fetch origin/main')])
  expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'origin/main'))
})

test('run asks origin for its default branch when the checkout does not know it', async () => {
  const { ghq, client, cwd } = await tracked(null)
  ghq.clone('acme/app')
  git(ghq.checkout('acme/app'), 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')

  await client.run({ ref })

  expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue-12')
})

test('run refuses a closed Task before it syncs, pointing to reopen rather than tracking it again', async () => {
  const { db, client, github } = await tracked(null)
  db.update(task).set({ closedAt: new Date() }).run()
  const sent = github.requests.length

  const error = await failure(client.run({ ref }))

  expect(error.code).toBe('BAD_REQUEST')
  expect(error.message).toBe(`${ref} is closed, so run \`monica task reopen ${ref}\``)
  expect(github.requests).toHaveLength(sent)
  expect(await client.bench.list()).toEqual([])
})

test('a Bench the Backend stopped preparing fails on the next start, and its setup is killed', async () => {
  const { db, client, restartTaskLedger, cwd } = await tracked(
    '#!/bin/sh\necho $$ > .pid\nsleep 30\n',
  )
  const running = failure(client.run({ ref }))
  await until(() => existsSync(join(cwd, '.pid')))
  const setupPid = Number(readFileSync(join(cwd, '.pid'), 'utf8'))

  const restarted = restartTaskLedger()
  restarted.taskLedger.start()

  expect((await running).code).toBe('PRECONDITION_FAILED')
  await until(() => !isAlive(setupPid))
  expect(db.select().from(bench).get()).toMatchObject({
    setupState: 'failed',
    setupError: 'the Backend stopped while preparing',
  })
  expect((await restarted.client.list({})).tasks).toMatchObject([
    { displayState: { state: 'setup_failed' } },
  ])
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
