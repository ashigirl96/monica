import { afterEach, expect, mock, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { eq } from 'drizzle-orm'

import { jobExecution } from './schema.ts'
import { createJobLedger, router, type SystemJob } from './server.ts'
import { captureInterval, inMemoryDb } from './testing.ts'

afterEach(() => {
  mock.restore()
})

const MINUTE = 60_000

function controlledJob(name: string, every: number) {
  const executions: PromiseWithResolvers<void>[] = []
  const job: SystemJob = {
    name,
    every,
    run() {
      const execution = Promise.withResolvers<void>()
      executions.push(execution)
      return execution.promise
    },
  }
  return { job, executions }
}

function setup({
  db = inMemoryDb(),
  jobs,
}: {
  db?: ReturnType<typeof inMemoryDb>
  jobs: SystemJob[]
}) {
  const interval = captureInterval()
  const clock = { at: new Date(2026, 9, 6, 12, 0, 0).getTime() }
  // system の Job は log を書かないので、home は作らない。
  const jobLedger = createJobLedger({
    db,
    home: join(tmpdir(), 'tania-job-unused'),
    systemJobs: jobs,
    now: () => new Date(clock.at),
  })
  const client = createRouterClient(router, { context: { db, jobLedger } })
  return {
    db,
    jobLedger,
    client,
    clock,
    tick: () => interval.tick!(),
    tickMs: () => interval.ms,
    advance: (ms: number) => {
      clock.at += ms
    },
  }
}

const settle = () => Bun.sleep(0)

test('a system Job runs at start, and list shows when it started, how it ended and when it runs next', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client } = setup({ jobs: [sync.job] })

  jobLedger.start()
  const running = await client.list()
  sync.executions[0]!.resolve()
  await settle()
  const done = await client.list()

  expect(running.jobs).toEqual([
    {
      name: 'task.sync',
      schedule: { type: 'every', ms: 5 * MINUTE },
      state: 'running',
      last: null,
      nextAt: new Date(2026, 9, 6, 12, 5, 0),
    },
  ])
  expect(done.jobs[0]).toMatchObject({
    state: 'active',
    last: { startedAt: new Date(2026, 9, 6, 12, 0, 0), result: 'succeeded' },
  })
})

test('a Job Execution that rejects is failed, and show gives the first line of its error', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, advance } = setup({ jobs: [sync.job] })

  jobLedger.start()
  advance(1500)
  sync.executions[0]!.reject(new Error('acme/app: GitHub answered 502\n<html>Bad Gateway</html>'))
  await settle()
  const shown = await client.show({ name: 'task.sync' })

  expect(shown).toEqual({
    name: 'task.sync',
    schedule: { type: 'every', ms: 5 * MINUTE },
    state: 'active',
    nextAt: new Date(2026, 9, 6, 12, 5, 0),
    shell: null,
    executions: [
      {
        scheduledAt: new Date(2026, 9, 6, 12, 0, 0),
        startedAt: new Date(2026, 9, 6, 12, 0, 0),
        endedAt: new Date(2026, 9, 6, 12, 0, 1, 500),
        result: 'failed',
        exitCode: null,
        error: 'acme/app: GitHub answered 502',
        logPath: null,
      },
    ],
  })
})

test('a tick after the scheduled time starts the Job, and the next one is due every from that start', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, tick, tickMs, advance } = setup({ jobs: [sync.job] })
  jobLedger.start()
  sync.executions[0]!.resolve()
  await settle()

  advance(4 * MINUTE + 50_000)
  tick()
  const early = sync.executions.length
  advance(20_000)
  tick()
  const listed = await client.list()
  const shown = await client.show({ name: 'task.sync' })

  expect(tickMs()).toBe(30_000)
  expect(early).toBe(1)
  expect(sync.executions).toHaveLength(2)
  expect(listed.jobs[0]).toMatchObject({
    state: 'running',
    last: { startedAt: new Date(2026, 9, 6, 12, 0, 0), result: 'succeeded' },
    nextAt: new Date(2026, 9, 6, 12, 10, 10),
  })
  expect(shown.executions.map((e) => [e.scheduledAt, e.startedAt])).toEqual([
    [new Date(2026, 9, 6, 12, 5, 0), new Date(2026, 9, 6, 12, 5, 10)],
    [new Date(2026, 9, 6, 12, 0, 0), new Date(2026, 9, 6, 12, 0, 0)],
  ])
})

test('a scheduled time that comes while the previous Job Execution runs is skipped and not recorded', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, tick, advance } = setup({ jobs: [sync.job] })
  jobLedger.start()

  advance(5 * MINUTE)
  tick()
  const whileRunning = await client.show({ name: 'task.sync' })
  sync.executions[0]!.resolve()
  await settle()
  advance(5 * MINUTE)
  tick()
  const after = await client.show({ name: 'task.sync' })

  expect(whileRunning.executions).toHaveLength(1)
  expect(whileRunning.nextAt).toEqual(new Date(2026, 9, 6, 12, 10, 0))
  expect(sync.executions).toHaveLength(2)
  expect(after.executions.map((e) => e.scheduledAt)).toEqual([
    new Date(2026, 9, 6, 12, 10, 0),
    new Date(2026, 9, 6, 12, 0, 0),
  ])
})

test('a scheduled time that passes while a Job Execution runs is skipped even when it ends before the tick', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, tick, advance } = setup({ jobs: [sync.job] })
  jobLedger.start()

  advance(5 * MINUTE + 5000)
  sync.executions[0]!.resolve()
  await settle()
  advance(15_000)
  tick()
  const shown = await client.show({ name: 'task.sync' })

  expect(sync.executions).toHaveLength(1)
  expect(shown.nextAt).toEqual(new Date(2026, 9, 6, 12, 10, 0))
})

test('after the Backend sleeps past several scheduled times, the Job runs once', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, tick, advance } = setup({ jobs: [sync.job] })
  jobLedger.start()
  sync.executions[0]!.resolve()
  await settle()

  advance(23 * MINUTE)
  tick()
  tick()
  const shown = await client.show({ name: 'task.sync' })

  expect(sync.executions).toHaveLength(2)
  expect(shown.executions[0]).toMatchObject({
    scheduledAt: new Date(2026, 9, 6, 12, 5, 0),
    startedAt: new Date(2026, 9, 6, 12, 23, 0),
  })
  expect(shown.nextAt).toEqual(new Date(2026, 9, 6, 12, 28, 0))
})

test('run starts the Job now without waiting for it, refuses a second while it runs, and keeps the next scheduled time', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const { jobLedger, client, advance } = setup({ jobs: [sync.job] })
  jobLedger.start()
  sync.executions[0]!.resolve()
  await settle()

  advance(2 * MINUTE)
  const ran = await client.run({ name: 'task.sync' })
  const second = await client.run({ name: 'task.sync' }).catch((error: unknown) => error)
  const shown = await client.show({ name: 'task.sync' })

  expect(ran).toEqual({ name: 'task.sync', startedAt: new Date(2026, 9, 6, 12, 2, 0) })
  expect(second).toMatchObject({ code: 'CONFLICT' })
  expect(sync.executions).toHaveLength(2)
  expect(shown).toMatchObject({ state: 'running', nextAt: new Date(2026, 9, 6, 12, 5, 0) })
  expect(shown.executions[0]).toMatchObject({
    scheduledAt: new Date(2026, 9, 6, 12, 2, 0),
    startedAt: new Date(2026, 9, 6, 12, 2, 0),
    result: null,
  })
})

test('a Job Execution the Backend stopped in the middle of is left without a result, and the next start makes it interrupted', async () => {
  const db = inMemoryDb()
  const before = controlledJob('task.sync', 5 * MINUTE)
  const stopped = setup({ db, jobs: [before.job] })
  stopped.jobLedger.start()
  stopped.jobLedger.stop()
  before.executions[0]!.resolve()
  await settle()
  const leftOver = await stopped.client.show({ name: 'task.sync' })

  const restarted = setup({ db, jobs: [controlledJob('task.sync', 5 * MINUTE).job] })
  restarted.jobLedger.start()
  const shown = await restarted.client.show({ name: 'task.sync' })

  expect(leftOver.executions.map((e) => e.result)).toEqual([null])
  expect(shown.executions.map((e) => e.result)).toEqual([null, 'interrupted'])
})

test('each Job keeps only its latest 100 Job Executions, the running one among them', async () => {
  const sync = controlledJob('task.sync', 5 * MINUTE)
  const other = controlledJob('task.other', 5 * MINUTE)
  const { db, jobLedger, client, advance } = setup({ jobs: [sync.job, other.job] })
  jobLedger.start()
  other.executions[0]!.resolve()
  for (let i = 0; i < 105; i++) {
    if (i > 0) {
      advance(1000)
      await client.run({ name: 'task.sync' })
    }
    if (i < 104) sync.executions[i]!.resolve()
    await settle()
  }
  const startedAt = (jobName: string) =>
    db
      .select({ startedAt: jobExecution.startedAt })
      .from(jobExecution)
      .where(eq(jobExecution.jobName, jobName))
      .orderBy(jobExecution.startedAt)
      .all()
      .map((row) => row.startedAt)

  expect(startedAt('task.sync')).toHaveLength(100)
  expect(startedAt('task.sync')[0]).toEqual(new Date(2026, 9, 6, 12, 0, 5))
  expect(startedAt('task.other')).toHaveLength(1)
})

test('show and run refuse a name no Job has with NOT_FOUND', async () => {
  const { client } = setup({ jobs: [controlledJob('task.sync', 5 * MINUTE).job] })

  await expect(client.show({ name: 'task.synk' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(client.run({ name: 'task.synk' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('createJobLedger refuses a system Job whose name has no ., which is kept apart from the names of user Jobs', () => {
  expect(() => setup({ jobs: [controlledJob('sync', 5 * MINUTE).job] })).toThrow(
    'the system Job sync needs a . in its name',
  )
})
