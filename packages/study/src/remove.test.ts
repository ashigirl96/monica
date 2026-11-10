import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq, sql } from 'drizzle-orm'

import { STALE_MS } from './activity.ts'
import type { Tools } from './cleanup.ts'
import { study, studyConversation, studyMessage, studyRepo } from './schema.ts'
import { systemJobs } from './server.ts'
import { init, result, said, studyFixture, until } from './study-fixture.ts'
import { fakeDocker, fakeNixStore } from './testing.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const { setup, watching } = studyFixture(cleanups)

test('remove moves the Study dir to trash/studies/<id>/tree, deletes the Study with its conversations, messages and Repo links, and keeps the Learning Preference', async () => {
  const { client, db, fake, home, deletedSessions } = setup()
  const { id } = await client.start({})
  const other = await client.start({})
  const dir = join(home, 'studies', id)
  writeFileSync(join(dir, 'MISSION.md'), '# Learn Rust\n')
  const preference = join(home, 'learning-preference', 'LEARNING-PREFERENCE.md')
  writeFileSync(preference, 'short answers\n')
  await client.repo.link({ id, repo: 'acme/alpha' })
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(init('session-a'), said('hi'), result())
  await watch.ended()
  const realDir = realpathSync(dir)

  await client.remove({ id })

  expect(existsSync(dir)).toBe(false)
  expect(readFileSync(join(home, 'trash/studies', id, 'tree', 'MISSION.md'), 'utf8')).toBe(
    '# Learn Rust\n',
  )
  expect(db.select({ id: study.id }).from(study).all()).toEqual([{ id: other.id }])
  expect(db.select().from(studyConversation).all()).toEqual([])
  expect(db.select().from(studyMessage).all()).toEqual([])
  expect(db.select().from(studyRepo).all()).toEqual([])
  expect((await client.list({})).studies.map((s) => s.id)).toEqual([other.id])
  expect(readFileSync(preference, 'utf8')).toBe('short answers\n')
  await until(() => deletedSessions.length === 1)
  expect(deletedSessions).toEqual([{ sessionId: 'session-a', dir: realDir }])
  await expect(client.remove({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('remove deletes the claude session under the real path of the Study dir when the home is reached through a symlink', async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'monica-study-real-')))
  const link = join(realpathSync(tmpdir()), `monica-study-link-${crypto.randomUUID()}`)
  symlinkSync(real, link)
  cleanups.push(() => rmSync(real, { recursive: true, force: true }))
  cleanups.push(() => rmSync(link, { force: true }))
  const { client, fake, deletedSessions } = setup({ home: link })
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(init('session-a'), said('hi'), result())
  await watch.ended()

  await client.remove({ id })

  await until(() => deletedSessions.length === 1)
  expect(deletedSessions).toEqual([{ sessionId: 'session-a', dir: join(real, 'studies', id) }])
})

test('remove of a Study without its dir deletes the row', async () => {
  const { client, home } = setup()
  const { id } = await client.start({})
  rmSync(join(home, 'studies', id), { recursive: true })

  await client.remove({ id })

  expect((await client.list({})).studies).toEqual([])
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('remove kills the claude of a running turn, which ends with turn-ended carrying an error, denies the pending permission and starts no reflection turn', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'run docker ps' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init())
  const answered = claude.options.canUseTool!(
    'Bash',
    { command: 'docker ps', description: 'List', dangerouslyDisableSandbox: true },
    { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' },
  )
  await watch.until((event) => event.type === 'message' && event.message.kind === 'permission')

  await client.remove({ id })

  expect(await answered).toMatchObject({ behavior: 'deny' })
  expect(alive(claude.pid)).toBe(false)
  await watch.ended()
  const ends = watch.events.flatMap((event) => (event.type === 'turn-ended' ? [event.error] : []))
  expect(ends).toEqual([expect.any(String)])
  expect(
    watch.events.flatMap((event) =>
      event.type === 'message' && event.message.kind === 'permission' ? [event.message.state] : [],
    ),
  ).toEqual(['pending', 'denied'])
  expect(watch.events.filter((event) => event.type === 'turn-started')).toHaveLength(1)
  expect(fake.claudes).toHaveLength(1)
})

test('remove closes every watch of the Study, and a watch or send after it is NOT_FOUND', async () => {
  const { client } = setup()
  const { id } = await client.start({})
  const other = await client.start({})
  const iterators = await Promise.all([client.watch({ id }), client.watch({ id })])
  const otherWatch = await watching(client, other.id)
  for (const iterator of iterators) await iterator.next()
  const nexts = iterators.map((iterator) =>
    iterator.next().then(
      (next) => (next.done ? 'closed' : 'open'),
      () => 'failed',
    ),
  )

  await client.remove({ id })

  expect(await Promise.all(nexts)).toEqual(['closed', 'closed'])
  await expect(client.watch({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(client.send({ id, text: 'hello' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await client.send({ id: other.id, text: 'hello' })
  await otherWatch.until((event) => event.type === 'turn-started')
})

const ROOT = '/nix/store/aaaa-profile'

/** Playground の掃除を nix-store の手前で止めた Study。 */
async function cleaningStudy() {
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
  const { id } = await fixture.client.start({})
  const env = join(fixture.home, 'studies', id, 'env')
  mkdirSync(env, { recursive: true })
  symlinkSync(ROOT, join(env, 'result'))
  fixture.db
    .update(study)
    .set({ lastActiveAt: new Date(Date.now() - STALE_MS - 1000) })
    .where(eq(study.id, id))
    .run()
  const cleaned = systemJobs(fixture.studyLedger)
    .find((job) => job.name === 'study.env-cleanup')!
    .run()
  await until(() => reached)
  return { ...fixture, id, release, cleaned }
}

test('a send or shell during remove is refused with CONFLICT', async () => {
  const { client, home, id, release, cleaned } = await cleaningStudy()
  const removed = client.remove({ id })
  cleanups.push(async () => {
    release()
    await Promise.all([removed, cleaned])
  })
  const refusal = () => client.send({ id, text: 'hello' }).catch((error: unknown) => error)
  // 消し始めるまでの send は、掃除中の CONFLICT で断られるので turn を始めない。
  let refused = await refusal()
  while (refused instanceof Error && refused.message.endsWith('is being cleaned up')) {
    refused = await refusal()
  }

  expect(refused).toMatchObject({ code: 'CONFLICT', message: `${id} is being removed` })
  await expect(client.shell({ prefix: id })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `${id} is being removed`,
  })
  await expect(client.remove({ id })).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(existsSync(join(home, 'studies', id))).toBe(true)
  release()
  await Promise.all([removed, cleaned])
})

test('remove waits for the playground cleanup of the Study to finish', async () => {
  const { client, home, id, release, cleaned } = await cleaningStudy()
  let done = false
  const removed = client.remove({ id }).then(() => (done = true))
  await Bun.sleep(20)

  expect(done).toBe(false)
  expect(existsSync(join(home, 'studies', id))).toBe(true)
  release()
  await Promise.all([removed, cleaned])
  expect(existsSync(join(home, 'studies', id))).toBe(false)
  expect(existsSync(join(home, 'trash/studies', id, 'tree'))).toBe(true)
})

test('a remove whose transaction fails puts the Study dir back', async () => {
  const { client, db, home } = setup()
  const { id } = await client.start({})
  writeFileSync(join(home, 'studies', id, 'MISSION.md'), '# Learn Rust\n')
  db.run(
    sql.raw(
      "CREATE TRIGGER keep_study BEFORE DELETE ON study BEGIN SELECT RAISE(ABORT, 'kept'); END",
    ),
  )

  await expect(client.remove({ id })).rejects.toThrow('kept')

  expect(readFileSync(join(home, 'studies', id, 'MISSION.md'), 'utf8')).toBe('# Learn Rust\n')
  expect(readdirSync(join(home, 'trash/studies'))).toEqual([])
  expect((await client.list({})).studies.map((s) => s.id)).toEqual([id])
  await client.send({ id, text: 'hello' })
})

/** Study の dir を、remove が行を消す前に Backend が止まった時と同じく捨て場へ移す。 */
function trashBy(home: string, id: string) {
  mkdirSync(join(home, 'trash/studies', id), { recursive: true })
  renameSync(join(home, 'studies', id), join(home, 'trash/studies', id, 'tree'))
}

test('start puts a trashed Study whose row is still there back at its path and leaves the others', async () => {
  const first = setup()
  const kept = await first.client.start({})
  const removed = await first.client.start({})
  writeFileSync(join(first.home, 'studies', kept.id, 'MISSION.md'), '# Learn Rust\n')
  trashBy(first.home, kept.id)
  await first.client.remove({ id: removed.id })

  const { studyLedger, home } = setup({ db: first.db, home: first.home })
  studyLedger.start()

  expect(readFileSync(join(home, 'studies', kept.id, 'MISSION.md'), 'utf8')).toBe('# Learn Rust\n')
  expect(readdirSync(join(home, 'trash/studies'))).toEqual([removed.id])
})

const dockerObject = (kind: 'container' | 'volume', id: string, studyId: string) => ({
  kind,
  id,
  labels: { 'monica.study': studyId },
})

function sweepOf(studyLedger: Parameters<typeof systemJobs>[0]) {
  return systemJobs(studyLedger).find((job) => job.name === 'study.trash-sweep')!
}

test('the system Job study.trash-sweep runs every 10 minutes and removes the trashed Studies that have no row', async () => {
  const objects = [dockerObject('container', 'c1', ''), dockerObject('volume', 'v1', '')]
  const docker = fakeDocker(objects)
  const { client, home, studyLedger } = setup({ tools: { docker: docker.docker, nixStore: null } })
  const removed = await client.start({})
  const crashed = await client.start({})
  const other = await client.start({})
  for (const object of objects) object.labels['monica.study'] = removed.id
  objects.push(dockerObject('container', 'c2', other.id))
  mkdirSync(join(home, 'studies', removed.id, 'env', 'home'), { recursive: true })
  await client.remove({ id: removed.id })
  trashBy(home, crashed.id)
  const sweep = sweepOf(studyLedger)

  expect(sweep.every).toBe(10 * 60_000)
  await sweep.run()

  expect(readdirSync(join(home, 'trash/studies'))).toEqual([crashed.id])
  expect(objects.map((object) => object.id)).toEqual(['c2'])
})

test('a sweep that cannot reach docker removes the tree, keeps the trashed dir, and removes the docker objects and the dir on the next run', async () => {
  const objects = [dockerObject('container', 'c1', '')]
  const down = fakeDocker(objects, { info: false })
  const up = fakeDocker(objects)
  let reachable = false
  const tools: Tools = {
    docker: (argv) => (reachable ? up : down).docker(argv),
    nixStore: null,
  }
  const { client, home, studyLedger } = setup({ tools })
  const { id } = await client.start({})
  objects[0]!.labels['monica.study'] = id
  await client.remove({ id })
  const sweep = sweepOf(studyLedger)

  await sweep.run()
  expect(readdirSync(join(home, 'trash/studies', id))).toEqual([])
  expect(objects).toHaveLength(1)

  reachable = true
  await sweep.run()
  expect(readdirSync(join(home, 'trash/studies'))).toEqual([])
  expect(objects).toEqual([])
})

test('a trashed Study the sweep cannot remove fails it on one line after the others are gone', async () => {
  const { client, home, studyLedger } = setup()
  const stuck = await client.start({})
  const gone = await client.start({})
  const locked = join(home, 'studies', stuck.id, 'prototypes')
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'main.rs'), 'fn main() {}\n')
  chmodSync(locked, 0o555)
  await client.remove({ id: stuck.id })
  await client.remove({ id: gone.id })
  const trashedLock = join(home, 'trash/studies', stuck.id, 'tree', 'prototypes')
  cleanups.push(() => chmodSync(trashedLock, 0o755))

  const error = await sweepOf(studyLedger)
    .run()
    .then(
      () => null,
      (thrown: Error) => thrown.message,
    )

  expect(error).toStartWith(`could not delete the trashed Studies: ${stuck.id}: `)
  expect(error).not.toContain('\n')
  expect(readdirSync(join(home, 'trash/studies'))).toEqual([stuck.id])
})
