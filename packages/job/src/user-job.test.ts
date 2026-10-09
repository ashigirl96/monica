import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'

import { jobExecution } from './schema.ts'
import { createJobLedger, router, type SystemJob } from './server.ts'
import { captureInterval, inMemoryDb } from './testing.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  mock.restore()
})

const sync: SystemJob = { name: 'task.sync', every: 5 * 60_000, run: () => Promise.resolve() }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'monica-job-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function setup({
  db = inMemoryDb(),
  home = tempDir(),
  at = new Date(2026, 9, 6, 12, 0, 0),
}: { db?: ReturnType<typeof inMemoryDb>; home?: string; at?: Date } = {}) {
  const interval = captureInterval()
  const clock = { at: at.getTime() }
  const jobLedger = createJobLedger({
    db,
    home,
    systemJobs: [sync],
    now: () => new Date(clock.at),
  })
  cleanups.push(() => jobLedger.stop())
  const client = createRouterClient(router, { context: { db, jobLedger } })
  return {
    db,
    home,
    jobLedger,
    client,
    tick: () => interval.tick!(),
    advanceTo: (date: Date) => {
      clock.at = date.getTime()
    },
  }
}

test('add registers a Job whose next scheduled time comes from its cron expression in local time', async () => {
  const { jobLedger, client } = setup()
  const cwd = tempDir()
  jobLedger.start()

  const added = await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'echo dreaming',
    cwd,
  })
  const listed = await client.list()

  expect(added).toEqual({ name: 'dreaming', nextAt: new Date(2026, 9, 7, 3, 0, 0) })
  expect(listed.jobs.at(-1)).toEqual({
    name: 'dreaming',
    schedule: { type: 'cron', expression: '0 3 * * *' },
    state: 'active',
    last: null,
    nextAt: new Date(2026, 9, 7, 3, 0, 0),
  })
})

test('add refuses a name taken, a name with ., a schedule it cannot read or that never comes, a cwd that is no absolute directory and a timeout over 24h', async () => {
  const { client } = setup()
  const cwd = tempDir()
  const job = { name: 'dreaming', schedule: '0 3 * * *', command: 'true', cwd }
  await client.add(job)

  const refusals = await Promise.all(
    [
      job,
      { ...job, name: 'task.sync' },
      { ...job, name: 'my.job' },
      { ...job, name: 'nightly', schedule: '0 3 * * * *' },
      { ...job, name: 'nightly', schedule: '0 0 30 2 *' },
      { ...job, name: 'nightly', cwd: join(cwd, 'gone') },
      { ...job, name: 'nightly', cwd: 'relative/dir' },
      { ...job, name: 'nightly', timeout: '25h' },
      { ...job, name: 'nightly', timeout: '1d' },
    ].map((input) =>
      client.add(input).then(
        () => null,
        (error: { code: string; message: string }) => [error.code, error.message],
      ),
    ),
  )

  expect(refusals).toEqual([
    ['CONFLICT', 'a Job is already named dreaming; remove it first to change it'],
    ['BAD_REQUEST', 'Input validation failed'],
    ['BAD_REQUEST', 'Input validation failed'],
    ['BAD_REQUEST', expect.stringMatching(/^could not read the schedule 0 3 \* \* \* \*: /)],
    ['BAD_REQUEST', 'the schedule 0 0 30 2 * never comes'],
    ['BAD_REQUEST', `the cwd ${join(cwd, 'gone')} is not a directory`],
    ['BAD_REQUEST', 'the cwd relative/dir is not an absolute path'],
    ['BAD_REQUEST', 'the timeout 25h is longer than 24h'],
    ['BAD_REQUEST', 'the timeout 1d is not a number and s, m or h, such as 30m or 2h'],
  ])
  expect((await client.list()).jobs.map((listed) => listed.name)).toEqual(['task.sync', 'dreaming'])
})

test('add runs a Job in $HOME for an hour unless told otherwise', async () => {
  const { client } = setup()

  await client.add({ name: 'dreaming', schedule: '0 3 * * *', command: 'true' })
  const shown = await client.show({ name: 'dreaming' })

  expect(shown.shell).toEqual({ command: 'true', cwd: homedir(), timeoutMs: 3_600_000 })
})

async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 2000; i++) {
    if (await done()) return
    await Bun.sleep(5)
  }
  throw new Error('timed out waiting')
}

async function ended(client: ReturnType<typeof setup>['client'], name: string) {
  let shown = await client.show({ name })
  await until(async () => {
    shown = await client.show({ name })
    return shown.executions[0]?.result != null
  })
  return shown
}

test('at its scheduled time a Job runs its command in its cwd, writes the output to a log, and succeeds on exit 0', async () => {
  const { client, jobLedger, home, tick, advanceTo } = setup()
  const cwd = tempDir()
  jobLedger.start()
  await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'pwd; echo "$0" >&2',
    cwd,
  })

  advanceTo(new Date(2026, 9, 7, 3, 0, 20))
  tick()
  const shown = await ended(client, 'dreaming')

  const logPath = join(home, 'logs/jobs/dreaming/2026-10-07T030020.000.log')
  expect(shown.executions).toEqual([
    {
      scheduledAt: new Date(2026, 9, 7, 3, 0, 0),
      startedAt: new Date(2026, 9, 7, 3, 0, 20),
      endedAt: new Date(2026, 9, 7, 3, 0, 20),
      result: 'succeeded',
      exitCode: 0,
      error: null,
      logPath,
    },
  ])
  expect(await Bun.file(logPath).text()).toBe(`${realpathSync(cwd)}\n/bin/sh\n`)
  expect(shown.nextAt).toEqual(new Date(2026, 9, 8, 3, 0, 0))
})

test('a command that exits non-zero fails with its exit code and the last line of its output', async () => {
  const { client, jobLedger, tick, advanceTo } = setup()
  jobLedger.start()
  await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'echo working; echo "permission denied: Edit" >&2; echo; exit 3',
    cwd: tempDir(),
  })

  advanceTo(new Date(2026, 9, 7, 3, 0, 20))
  tick()
  const shown = await ended(client, 'dreaming')

  expect(shown.executions[0]).toMatchObject({
    result: 'failed',
    exitCode: 3,
    error: 'exit 3: permission denied: Edit',
  })
})

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

test('a Job still running at its timeout is timed out, its process group getting SIGTERM and 2 seconds before SIGKILL', async () => {
  const { client, jobLedger } = setup()
  const cwd = tempDir()
  jobLedger.start()
  await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: [
      `sh -c 'trap "sleep 0.3; touch cleaned; exit 0" TERM; touch trapping; while :; do sleep 0.05; done' &`,
      `sh -c 'trap "" TERM; exec sleep 30' &`,
      'echo $! > stubborn',
      'sleep 30',
    ].join('\n'),
    cwd,
    timeout: '30m',
  })
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
    if (ms !== 30 * 60_000) return realSetTimeout(callback, ms)
    fireTimeout = callback
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout)

  await client.run({ name: 'dreaming' })
  await until(
    () =>
      existsSync(join(cwd, 'trapping')) &&
      existsSync(join(cwd, 'stubborn')) &&
      fireTimeout !== undefined,
  )
  const stubborn = Number(readFileSync(join(cwd, 'stubborn'), 'utf8'))
  const termAt = Date.now()
  setSystemTime(termAt)
  cleanups.push(() => setSystemTime())
  fireTimeout!()
  await until(() => existsSync(join(cwd, 'cleaned')))
  setSystemTime(termAt + 1_999)
  await graceLoops(2)
  expect(isAlive(stubborn)).toBe(true)
  setSystemTime(termAt + 2_000)
  const shown = await ended(client, 'dreaming')

  expect(shown.executions[0]).toMatchObject({ result: 'timed_out', error: 'timed out after 1800s' })
  await until(() => !isAlive(stubborn))
})

test('a scheduled time the Backend restarts across does not run right after the start, and the next counts from the start', async () => {
  const db = inMemoryDb()
  const before = setup({ db, at: new Date(2026, 9, 7, 2, 50, 0) })
  before.jobLedger.start()
  await before.client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'true',
    cwd: tempDir(),
  })
  before.jobLedger.stop()

  const after = setup({ db, at: new Date(2026, 9, 7, 3, 5, 0) })
  after.jobLedger.start()
  after.tick()
  const shown = await after.client.show({ name: 'dreaming' })

  expect(shown).toMatchObject({ state: 'active', nextAt: new Date(2026, 9, 8, 3, 0, 0) })
  expect(shown.executions).toEqual([])
})

test('a scheduled time the tick notices well past the tick interval, as after a sleep, does not run, and the next counts from then', async () => {
  const { client, jobLedger, tick, advanceTo } = setup()
  jobLedger.start()
  await client.add({ name: 'dreaming', schedule: '0 3 * * *', command: 'true', cwd: tempDir() })

  advanceTo(new Date(2026, 9, 7, 8, 30, 0))
  tick()
  const shown = await client.show({ name: 'dreaming' })

  expect(shown).toMatchObject({ state: 'active', nextAt: new Date(2026, 9, 8, 3, 0, 0) })
  expect(shown.executions).toEqual([])
})

test('a paused Job does not run on its schedule but run starts it, it stays paused across a restart, and resume counts the next from now', async () => {
  const db = inMemoryDb()
  const before = setup({ db })
  before.jobLedger.start()
  await before.client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'true',
    cwd: tempDir(),
  })

  const paused = await before.client.pause({ name: 'dreaming' })
  before.advanceTo(new Date(2026, 9, 7, 3, 0, 10))
  before.tick()
  const notRun = await before.client.show({ name: 'dreaming' })
  await before.client.run({ name: 'dreaming' })
  const ran = await ended(before.client, 'dreaming')
  before.jobLedger.stop()

  const after = setup({ db, at: new Date(2026, 9, 7, 12, 0, 0) })
  after.jobLedger.start()
  const restarted = await after.client.list()
  const resumed = await after.client.resume({ name: 'dreaming' })
  const shown = await after.client.show({ name: 'dreaming' })

  expect(paused).toEqual({ name: 'dreaming' })
  expect(notRun).toMatchObject({ state: 'paused', nextAt: null, executions: [] })
  expect(ran.executions).toMatchObject([{ result: 'succeeded' }])
  expect(restarted.jobs.at(-1)).toMatchObject({ name: 'dreaming', state: 'paused', nextAt: null })
  expect(resumed).toEqual({ name: 'dreaming', nextAt: new Date(2026, 9, 8, 3, 0, 0) })
  expect(shown).toMatchObject({ state: 'active', nextAt: new Date(2026, 9, 8, 3, 0, 0) })
})

test('remove, pause and resume refuse a system Job with BAD_REQUEST and a name no Job has with NOT_FOUND', async () => {
  const { client } = setup()

  const refusals = await Promise.all(
    (['remove', 'pause', 'resume'] as const).flatMap((procedure) =>
      ['task.sync', 'nightly'].map((name) =>
        client[procedure]({ name }).then(
          () => null,
          (error: { code: string; message: string }) => [error.code, error.message],
        ),
      ),
    ),
  )

  expect(refusals).toEqual([
    ['BAD_REQUEST', 'task.sync is a system Job, so it cannot be removed'],
    ['NOT_FOUND', 'no Job is named nightly'],
    ['BAD_REQUEST', 'task.sync is a system Job, so it cannot be paused'],
    ['NOT_FOUND', 'no Job is named nightly'],
    ['BAD_REQUEST', 'task.sync is a system Job, so it cannot be resumed'],
    ['NOT_FOUND', 'no Job is named nightly'],
  ])
})

test('remove refuses a running Job, and once it ends removes the Job with its Job Executions and their logs', async () => {
  const { db, home, client, jobLedger } = setup()
  const cwd = tempDir()
  jobLedger.start()
  await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'until [ -e go ]; do sleep 0.05; done',
    cwd,
  })
  await client.add({ name: 'review', schedule: '0 4 * * *', command: 'true', cwd })
  await client.run({ name: 'review' })
  await ended(client, 'review')

  await client.run({ name: 'dreaming' })
  const whileRunning = await client.remove({ name: 'dreaming' }).catch((error: unknown) => error)
  writeFileSync(join(cwd, 'go'), '')
  const { executions } = await ended(client, 'dreaming')
  const logBefore = existsSync(executions[0]!.logPath!)
  const removed = await client.remove({ name: 'dreaming' })

  expect(whileRunning).toMatchObject({
    code: 'CONFLICT',
    message: 'dreaming is running; remove it once it ends',
  })
  expect(logBefore).toBe(true)
  expect(removed).toEqual({ name: 'dreaming' })
  expect((await client.list()).jobs.map((job) => job.name)).toEqual(['task.sync', 'review'])
  expect(existsSync(join(home, 'logs/jobs/dreaming'))).toBe(false)
  expect(existsSync(join(home, 'logs/jobs/review'))).toBe(true)
  expect(
    db
      .select({ jobName: jobExecution.jobName })
      .from(jobExecution)
      .all()
      .map((row) => row.jobName)
      .toSorted(),
  ).toEqual(['review', 'task.sync'])
})

test('a Job Execution dropped to keep the latest 100 takes its log with it', async () => {
  const { client, jobLedger, advanceTo } = setup()
  jobLedger.start()
  await client.add({ name: 'review', schedule: '0 4 * * *', command: 'true', cwd: tempDir() })

  const logPaths: string[] = []
  for (let i = 0; i < 101; i++) {
    advanceTo(new Date(2026, 9, 6, 13, 0, i))
    await client.run({ name: 'review' })
    logPaths.push((await ended(client, 'review')).executions[0]!.logPath!)
  }

  expect(existsSync(logPaths[0]!)).toBe(false)
  expect(logPaths.slice(1).every((path) => existsSync(path))).toBe(true)
})

test('stop kills the process group of a running Job, and the next start makes its Job Execution interrupted', async () => {
  const db = inMemoryDb()
  const cwd = tempDir()
  const before = setup({ db })
  before.jobLedger.start()
  await before.client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: `sh -c 'trap "" TERM; echo $$ > child; exec sleep 30' & sleep 30`,
    cwd,
  })
  await before.client.run({ name: 'dreaming' })
  await until(
    () => existsSync(join(cwd, 'child')) && readFileSync(join(cwd, 'child'), 'utf8') !== '',
  )
  const child = Number(readFileSync(join(cwd, 'child'), 'utf8'))

  before.jobLedger.stop()
  await until(() => !isAlive(child))
  const after = setup({ db })
  after.jobLedger.start()
  const shown = await after.client.show({ name: 'dreaming' })

  expect(shown.executions).toMatchObject([{ result: 'interrupted', endedAt: null }])
})

test('a scheduled time that comes while the Job runs is skipped and not recorded, and the next is the one after', async () => {
  const { client, jobLedger, tick, advanceTo } = setup({ at: new Date(2026, 9, 7, 2, 59, 0) })
  const cwd = tempDir()
  jobLedger.start()
  await client.add({
    name: 'dreaming',
    schedule: '0 3 * * *',
    command: 'until [ -e go ]; do sleep 0.05; done',
    cwd,
  })

  await client.run({ name: 'dreaming' })
  advanceTo(new Date(2026, 9, 7, 3, 0, 20))
  tick()
  writeFileSync(join(cwd, 'go'), '')
  const shown = await ended(client, 'dreaming')

  expect(shown.executions.map((e) => e.scheduledAt)).toEqual([new Date(2026, 9, 7, 2, 59, 0)])
  expect(shown.nextAt).toEqual(new Date(2026, 9, 8, 3, 0, 0))
})

test('a Job whose cwd is gone since add fails with the reason it could not spawn', async () => {
  const { client, jobLedger } = setup()
  const cwd = tempDir()
  jobLedger.start()
  await client.add({ name: 'dreaming', schedule: '0 3 * * *', command: 'true', cwd })
  rmSync(cwd, { recursive: true })

  await client.run({ name: 'dreaming' })
  const shown = await ended(client, 'dreaming')

  expect(shown.executions[0]).toMatchObject({
    result: 'failed',
    exitCode: null,
    error: expect.stringMatching(/^spawn failed: /),
  })
})
