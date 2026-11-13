import { afterEach, expect, setDefaultTimeout, setSystemTime, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { eq } from 'drizzle-orm'

import { STALE_MS } from './activity.ts'
import { createRunner } from './cleanup.ts'
import { study as studyTable } from './schema.ts'
import { systemJobs } from './server.ts'
import { studyFixture, until } from './study-fixture.ts'
import { fakeDocker, fakeNixStore } from './testing.ts'

// 本物の nix の nix-store --gc --print-dead は store 全体を走査して数秒かかる。
setDefaultTimeout(30_000)

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const { setup, watching } = studyFixture(cleanups)

const DAY = 24 * 60 * 60_000
const ROOT = '/nix/store/aaaa-profile'

type Fixture = ReturnType<typeof setup>

function lastActiveAt({ db }: Fixture, id: string, at: number) {
  db.update(studyTable)
    .set({ lastActiveAt: new Date(at) })
    .where(eq(studyTable.id, id))
    .run()
}

const staleAgo = () => Date.now() - STALE_MS - DAY

function rowOf({ db }: Fixture, id: string) {
  return db.select().from(studyTable).where(eq(studyTable.id, id)).get()!
}

function envOf({ home }: Fixture, id: string) {
  const env = join(home, 'studies', id, 'env')
  mkdirSync(join(env, 'mise'), { recursive: true })
  writeFileSync(join(env, 'mise', 'tool'), 'x')
  return env
}

const cleanUp = (fixture: Fixture) =>
  systemJobs(fixture.studyLedger)
    .find((job) => job.name === 'study.env-cleanup')!
    .run()

test('the system Job study.env-cleanup runs once a day and removes the env of a Study last touched longer ago than STALE_MS', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const env = envOf(fixture, id)
  cleanups.push(() => setSystemTime())

  const job = systemJobs(fixture.studyLedger).find((j) => j.name === 'study.env-cleanup')!
  expect(job.every).toBe(DAY)

  setSystemTime(new Date(Date.now() + STALE_MS - DAY))
  await job.run()
  expect(existsSync(env)).toBe(true)

  setSystemTime(new Date(Date.now() + 2 * DAY))
  await job.run()
  expect(existsSync(env)).toBe(false)
  expect(existsSync(join(fixture.home, 'studies', id))).toBe(true)
})

test('a Study touched a day short of STALE_MS ago, or entered by study.shell since, keeps its env', async () => {
  const fixture = setup()
  const short = await fixture.client.start({})
  const entered = await fixture.client.start({})
  const shortEnv = envOf(fixture, short.id)
  const enteredEnv = envOf(fixture, entered.id)
  lastActiveAt(fixture, short.id, Date.now() - STALE_MS + DAY)
  lastActiveAt(fixture, entered.id, staleAgo())
  await fixture.client.shell({ prefix: entered.id })

  await cleanUp(fixture)

  expect([existsSync(shortEnv), existsSync(enteredEnv)]).toEqual([true, true])
})

test('a Study whose turn is running is left for the next run, and a send during the cleanup is refused with CONFLICT and leaves running false in watch', async () => {
  const nix = fakeNixStore({ refs: { [ROOT]: [] }, live: [] })
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  let reached = false
  const fixture = setup({
    tools: {
      docker: null,
      nixStore: async (argv) => {
        reached = true
        await held
        return nix.nixStore(argv)
      },
    },
  })
  const busy = await fixture.client.start({})
  const busyEnv = envOf(fixture, busy.id)
  await fixture.client.send({ id: busy.id, text: 'hello' })
  lastActiveAt(fixture, busy.id, staleAgo())

  await cleanUp(fixture)
  expect(existsSync(busyEnv)).toBe(true)

  const quiet = await fixture.client.start({})
  const quietEnv = envOf(fixture, quiet.id)
  symlinkSync(ROOT, join(quietEnv, 'result'))
  lastActiveAt(fixture, busy.id, Date.now())
  lastActiveAt(fixture, quiet.id, staleAgo())
  const watch = await watching(fixture.client, quiet.id)
  const cleaned = cleanUp(fixture)
  await until(() => reached)

  await expect(fixture.client.send({ id: quiet.id, text: 'hello' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `the Playground of ${quiet.id} is being cleaned up`,
    data: { reason: 'playground-cleaning' },
  })
  expect(existsSync(quietEnv)).toBe(true)
  release()
  await cleaned

  expect(existsSync(quietEnv)).toBe(false)
  expect((await fixture.client.get({ id: quiet.id })).running).toBe(false)
  expect(watch.events.map((event) => event.type)).toEqual(['snapshot'])
  expect(watch.events[0]).toMatchObject({ running: false })
})

test('shell during Playground cleanup is refused without touching the Study, and can enter after cleanup', async () => {
  const { promise: reached, resolve: markReached } = Promise.withResolvers<void>()
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const nix = fakeNixStore({ refs: { [ROOT]: [] }, live: [] })
  const fixture = setup({
    tools: {
      docker: null,
      nixStore: async (argv) => {
        markReached()
        await held
        return nix.nixStore(argv)
      },
    },
  })
  const { id } = await fixture.client.start({})
  const env = envOf(fixture, id)
  symlinkSync(ROOT, join(env, 'result'))
  const stale = staleAgo()
  lastActiveAt(fixture, id, stale)
  const cleaned = fixture.studyLedger.cleanPlaygrounds()
  cleanups.push(async () => {
    release()
    await cleaned
  })
  await reached

  const entered = await fixture.client.shell({ prefix: id }).then(
    () => 'entered',
    (error: { code: string }) => error.code,
  )
  const { studies } = await fixture.client.list({})
  expect(existsSync(env)).toBe(true)
  release()
  await cleaned

  expect(existsSync(env)).toBe(false)
  expect(entered).toBe('CONFLICT')
  expect(studies[0]!.lastActivityAt.getTime()).toBe(stale)
  expect((await fixture.client.shell({ prefix: id })).studyId).toBe(id)
})

test('the cleanup removes only what the .gitignore of each prototype ignores, and leaves a prototype without .git alone', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const prototypes = join(fixture.home, 'studies', id, 'prototypes')
  const files = {
    'a/.gitignore': 'node_modules\n',
    'a/node_modules/x': 'x',
    'a/main.ts': 'x',
    'b/node_modules/x': 'x',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(prototypes, path)), { recursive: true })
    writeFileSync(join(prototypes, path), content)
  }
  Bun.spawnSync(['git', 'init', '-q', join(prototypes, 'a')], { env: process.env })
  lastActiveAt(fixture, id, staleAgo())

  await cleanUp(fixture)

  expect(Object.keys(files).filter((path) => existsSync(join(prototypes, path)))).toEqual([
    'a/.gitignore',
    'a/main.ts',
    'b/node_modules/x',
  ])
})

test("the cleanup does not run the commands or reach the work tree that a Tutor wrote into a prototype's .git", async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const prototype = join(fixture.home, 'studies', id, 'prototypes', 'a')
  const outside = mkdtempSync(join(tmpdir(), 'study-outside-'))
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, '.gitignore'), 'secret\n')
  writeFileSync(join(outside, 'secret'), 'keep')
  mkdirSync(prototype, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', prototype], { env: process.env })
  const ran = join(outside, 'ran')
  const config = (key: string, value: string) =>
    Bun.spawnSync(['git', '-C', prototype, 'config', key, value], { env: process.env })
  config('core.fsmonitor', `touch ${ran}; false`)
  config('core.worktree', outside)
  lastActiveAt(fixture, id, staleAgo())

  await cleanUp(fixture).catch(() => {})

  expect(existsSync(ran)).toBe(false)
  expect(existsSync(join(outside, 'secret'))).toBe(true)
})

test('the cleanup skips a prototype whose .git is a file pointing elsewhere', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const prototype = join(fixture.home, 'studies', id, 'prototypes', 'a')
  const outside = mkdtempSync(join(tmpdir(), 'study-outside-'))
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
  Bun.spawnSync(['git', 'init', '-q', outside], { env: process.env })
  writeFileSync(join(outside, '.gitignore'), 'secret\n')
  writeFileSync(join(outside, 'secret'), 'keep')
  mkdirSync(prototype, { recursive: true })
  writeFileSync(join(prototype, '.git'), `gitdir: ${join(outside, '.git')}\n`)
  Bun.spawnSync(['git', '-C', outside, 'config', 'core.worktree', outside], { env: process.env })
  lastActiveAt(fixture, id, staleAgo())

  await cleanUp(fixture).catch(() => {})

  expect(existsSync(join(outside, 'secret'))).toBe(true)
})

test('the cleanup does not follow a prototypes symlink out of the Study', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const outside = mkdtempSync(join(tmpdir(), 'study-outside-'))
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
  const repo = join(outside, 'a')
  mkdirSync(repo)
  Bun.spawnSync(['git', 'init', '-q', repo], { env: process.env })
  writeFileSync(join(repo, '.gitignore'), 'secret\n')
  writeFileSync(join(repo, 'secret'), 'keep')
  symlinkSync(outside, join(fixture.home, 'studies', id, 'prototypes'))
  lastActiveAt(fixture, id, staleAgo())

  await cleanUp(fixture).catch(() => {})

  expect(existsSync(join(repo, 'secret'))).toBe(true)
})

test('the cleanup skips a prototype whose .git/config is not a regular file without letting git read it', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const prototype = join(fixture.home, 'studies', id, 'prototypes', 'a')
  mkdirSync(prototype, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', prototype], { env: process.env })
  rmSync(join(prototype, '.git', 'config'))
  Bun.spawnSync(['mkfifo', join(prototype, '.git', 'config')], { env: process.env })
  lastActiveAt(fixture, id, staleAgo())

  const outcome = await Promise.race([
    cleanUp(fixture).then(() => 'done'),
    Bun.sleep(5000).then(() => 'still waiting'),
  ])

  expect(outcome).toBe('done')
})

test('a git that does not return in time is killed with its group, fails the cleanup on one line, and the next prototype is still cleaned', async () => {
  const fixture = setup()
  const { id } = await fixture.client.start({})
  const prototypes = join(fixture.home, 'studies', id, 'prototypes')
  for (const name of ['a', 'b']) {
    mkdirSync(join(prototypes, name, 'node_modules'), { recursive: true })
    writeFileSync(join(prototypes, name, '.gitignore'), 'node_modules\n')
    writeFileSync(join(prototypes, name, 'node_modules', 'x'), 'x')
    Bun.spawnSync(['git', 'init', '-q', join(prototypes, name)], { env: process.env })
  }
  // git は .git/info/exclude の FIFO を開いたまま、書き手を待ち続ける。
  rmSync(join(prototypes, 'a', '.git', 'info', 'exclude'))
  Bun.spawnSync(['mkfifo', join(prototypes, 'a', '.git', 'info', 'exclude')], { env: process.env })
  lastActiveAt(fixture, id, staleAgo())
  const realSetTimeout = globalThis.setTimeout
  const expiries: (() => void)[] = []
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number,
  ) => {
    if (ms === 60_000) expiries.push(callback)
    return realSetTimeout(callback, ms)
  }) as typeof setTimeout)
  cleanups.push(() => spy.mockRestore())

  const failed = cleanUp(fixture).then(
    () => null,
    (error: Error) => error.message,
  )
  await until(() => expiries.length === 1)
  expiries[0]!()

  const message = await failed
  expect(message).toStartWith(`could not clean up the Playgrounds: ${id}: `)
  expect(message).toContain('timed out')
  expect(message).not.toContain('\n')
  expect(existsSync(join(prototypes, 'b', 'node_modules', 'x'))).toBe(false)
})

test('a Study whose prototypes cannot be read fails the cleanup on one line after the later Studies are cleaned', async () => {
  const fixture = setup()
  const older = await fixture.client.start({})
  const later = await fixture.client.start({})
  const unreadable = join(fixture.home, 'studies', older.id, 'prototypes')
  mkdirSync(unreadable)
  chmodSync(unreadable, 0o000)
  cleanups.push(() => chmodSync(unreadable, 0o755))
  const laterEnv = envOf(fixture, later.id)
  lastActiveAt(fixture, older.id, staleAgo() - 1)
  lastActiveAt(fixture, later.id, staleAgo())

  const failed = await cleanUp(fixture).then(
    () => null,
    (error: Error) => error.message,
  )

  expect(failed).toStartWith(`could not clean up the Playgrounds: ${older.id}: `)
  expect(failed).toContain('EACCES')
  expect(failed).not.toContain('\n')
  expect(existsSync(laterEnv)).toBe(false)
})

test('playground_removed_at is written when the env is removed, not when there was none, and the list marks the Study', async () => {
  const fixture = setup()
  const withEnv = await fixture.client.start({})
  const without = await fixture.client.start({})
  envOf(fixture, withEnv.id)
  const stale = staleAgo()
  lastActiveAt(fixture, withEnv.id, stale)
  lastActiveAt(fixture, without.id, stale)

  await cleanUp(fixture)

  expect(rowOf(fixture, withEnv.id).playgroundRemovedAt).not.toBeNull()
  expect(rowOf(fixture, withEnv.id).lastActiveAt.getTime()).toBe(stale)
  expect(rowOf(fixture, without.id).playgroundRemovedAt).toBeNull()
  const { studies } = await fixture.client.list({})
  expect(Object.fromEntries(studies.map((s) => [s.id, s.playgroundRemoved]))).toEqual({
    [withEnv.id]: true,
    [without.id]: false,
  })
})

type DockerKind = 'container' | 'network' | 'volume' | 'image'
const dockerObject = (kind: DockerKind, id: string, labels: Record<string, string>) => ({
  kind,
  id,
  labels,
})

test("the cleanup removes the containers, networks, volumes and images of the Study's two labels in that order, and no other Study's", async () => {
  const docker = fakeDocker([])
  const fixture = setup({ tools: { docker: docker.docker, nixStore: null } })
  const stale = await fixture.client.start({})
  const other = await fixture.client.start({})
  docker.objects.push(
    dockerObject('container', 'c1', { 'monica.study': stale.id }),
    dockerObject('container', 'c2', { 'com.docker.compose.project': stale.id }),
    dockerObject('network', 'n1', { 'monica.study': stale.id }),
    dockerObject('volume', 'v1', { 'com.docker.compose.project': stale.id }),
    dockerObject('image', 'i1', { 'monica.study': stale.id }),
    dockerObject('container', 'c3', { 'monica.study': other.id }),
    dockerObject('volume', 'v2', { 'com.docker.compose.project': other.id }),
  )
  lastActiveAt(fixture, stale.id, staleAgo())

  await cleanUp(fixture)

  const filter = (label: string) => ['--filter', `label=${label}=${stale.id}`]
  expect(docker.calls).toEqual([
    ['info'],
    ['ps', '-aq', ...filter('monica.study')],
    ['rm', '-f', 'c1'],
    ['network', 'ls', '-q', ...filter('monica.study')],
    ['network', 'rm', 'n1'],
    ['volume', 'ls', '-q', ...filter('monica.study')],
    ['image', 'ls', '-q', ...filter('monica.study')],
    ['image', 'rm', '-f', 'i1'],
    ['ps', '-aq', ...filter('com.docker.compose.project')],
    ['rm', '-f', 'c2'],
    ['network', 'ls', '-q', ...filter('com.docker.compose.project')],
    ['volume', 'ls', '-q', ...filter('com.docker.compose.project')],
    ['volume', 'rm', '-f', 'v1'],
    ['image', 'ls', '-q', ...filter('com.docker.compose.project')],
  ])
  expect(docker.objects.map((o) => o.id)).toEqual(['c3', 'v2'])
})

test('a docker that does not answer docker info, or no docker, skips the docker step and the Job succeeds', async () => {
  const down = fakeDocker([dockerObject('container', 'c1', {})], { info: false })
  for (const docker of [down.docker, null]) {
    const fixture = setup({ tools: { docker, nixStore: null } })
    const { id } = await fixture.client.start({})
    const env = envOf(fixture, id)
    lastActiveAt(fixture, id, staleAgo())

    await cleanUp(fixture)

    expect(existsSync(env)).toBe(false)
  }
  expect(down.calls).toEqual([['info']])
})

test("the nix paths deleted are the dead part of the env's closure, without what dead paths outside it refer to, in one delete", async () => {
  const result = '/nix/store/bbbb-result'
  const tool = '/nix/store/cccc-tool'
  const lib = '/nix/store/dddd-lib'
  const glibc = '/nix/store/eeee-glibc'
  const outsideDead = '/nix/store/ffff-old'
  const outsideLive = '/nix/store/gggg-system'
  const nix = fakeNixStore({
    refs: {
      [ROOT]: [tool, glibc],
      [result]: [glibc],
      [tool]: [lib],
      [lib]: [],
      [glibc]: [],
      [outsideDead]: [tool],
      [outsideLive]: [glibc],
    },
    live: [outsideLive, glibc],
  })
  const fixture = setup({ tools: { docker: null, nixStore: nix.nixStore } })
  const rooted = await fixture.client.start({})
  const env = envOf(fixture, rooted.id)
  symlinkSync(ROOT, join(env, 'profile-1-link'))
  symlinkSync(`${result}/bin/x`, join(env, 'mise', 'result'))
  lastActiveAt(fixture, rooted.id, staleAgo())

  await cleanUp(fixture)

  expect(nix.calls.filter((argv) => argv[0] === '--delete')).toEqual([['--delete', ROOT, result]])
  expect(nix.paths().toSorted()).toEqual([tool, lib, glibc, outsideDead, outsideLive].toSorted())

  nix.calls.length = 0
  const rootless = await fixture.client.start({})
  envOf(fixture, rootless.id)
  lastActiveAt(fixture, rootless.id, staleAgo())
  await cleanUp(fixture)
  expect(nix.calls).toEqual([])
})

test('an env the cleanup cannot remove fails it on one line after the other Studies are done, and its nix paths are left', async () => {
  const nix = fakeNixStore({ refs: { [ROOT]: [] }, live: [] })
  const fixture = setup({ tools: { docker: null, nixStore: nix.nixStore } })
  const stuck = await fixture.client.start({})
  const other = await fixture.client.start({})
  const stuckEnv = envOf(fixture, stuck.id)
  const otherEnv = envOf(fixture, other.id)
  symlinkSync(ROOT, join(stuckEnv, 'result'))
  chmodSync(stuckEnv, 0o555)
  cleanups.push(() => chmodSync(stuckEnv, 0o755))
  // 消せない Study を先に回し、その後の Study も消されることを見る。
  lastActiveAt(fixture, stuck.id, staleAgo() - 1)
  lastActiveAt(fixture, other.id, staleAgo())

  const failed = await cleanUp(fixture).then(
    () => null,
    (error: Error) => error.message,
  )

  expect(failed).toStartWith(`could not clean up the Playgrounds: ${stuck.id}: `)
  expect(failed).not.toContain('\n')
  expect(existsSync(otherEnv)).toBe(false)
  expect(nix.paths()).toEqual([ROOT])
  expect(nix.calls.some((argv) => argv[0] === '--delete')).toBe(false)
  expect(rowOf(fixture, stuck.id).playgroundRemovedAt).toBeNull()
})

function nixStore(...argv: string[]): string {
  const done = Bun.spawnSync(['nix-store', ...argv], { env: process.env })
  if (done.exitCode !== 0) throw new Error(done.stderr.toString())
  return done.stdout.toString().trim()
}

test.skipIf(!Bun.which('nix-store'))(
  'with the real nix, the cleanup deletes the store path rooted only in the env and keeps the one rooted outside',
  async () => {
    const fixture = setup({ tools: createRunner().tools() })
    const scratch = mkdtempSync(join(tmpdir(), 'monica-nix-'))
    const add = (name: string) => {
      writeFileSync(join(scratch, name), `${name} ${Bun.randomUUIDv7()}`)
      return nixStore('--add', join(scratch, name))
    }
    const inEnv = add('in-env')
    const outside = add('outside')
    const outsideRoot = join(scratch, 'outside-root')
    cleanups.push(() => {
      rmSync(outsideRoot, { force: true })
      nixStore('--delete', outside)
      rmSync(scratch, { recursive: true, force: true })
    })
    const { id } = await fixture.client.start({})
    const env = envOf(fixture, id)
    nixStore('--add-root', join(env, 'result'), '--indirect', '--realise', inEnv)
    nixStore('--add-root', outsideRoot, '--indirect', '--realise', outside)
    lastActiveAt(fixture, id, staleAgo())

    await cleanUp(fixture)

    expect([existsSync(inEnv), existsSync(outside)]).toEqual([false, true])
  },
)
