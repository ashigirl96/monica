import { expect, test } from 'bun:test'

import { formatters } from './cli.ts'
import type { JobExecution, JobItem } from './contract.ts'

const MINUTE = 60_000

// local time の部品から作るので、どの timezone で走らせても同じ文字列になる。
const at = (hours: number, minutes: number, seconds: number, ms = 0) =>
  new Date(2026, 9, 6, hours, minutes, seconds, ms)

const sync = (overrides: Partial<JobItem>): JobItem => ({
  name: 'task.sync',
  schedule: { type: 'every', ms: 5 * MINUTE },
  state: 'active',
  last: { startedAt: at(12, 0, 0), result: 'succeeded' },
  nextAt: at(12, 5, 0),
  ...overrides,
})

const execution = (overrides: Partial<JobExecution>): JobExecution => ({
  scheduledAt: at(12, 0, 0),
  startedAt: at(12, 0, 0),
  endedAt: at(12, 0, 1, 500),
  result: 'succeeded',
  exitCode: null,
  error: null,
  logPath: null,
  ...overrides,
})

test('list prints each Job with its schedule, state, last start and result, and next time in local time', () => {
  const text = formatters.list({
    jobs: [
      sync({}),
      sync({
        name: 'nightly',
        schedule: { type: 'every', ms: 24 * 60 * MINUTE },
        state: 'running',
        last: { startedAt: at(3, 0, 12), result: 'interrupted' },
        nextAt: null,
      }),
      sync({ name: 'fresh', schedule: { type: 'every', ms: 90_000 }, last: null }),
    ],
  })

  expect(text).toBe(
    [
      'NAME       SCHEDULE   STATE    LAST                             NEXT',
      'task.sync  every 5m   active   2026-10-06 12:00:00 succeeded    2026-10-06 12:05:00',
      'nightly    every 24h  running  2026-10-06 03:00:12 interrupted  -',
      'fresh      every 90s  active   -                                2026-10-06 12:05:00',
    ].join('\n'),
  )
})

test('list says so when there are no Jobs', () => {
  expect(formatters.list({ jobs: [] })).toBe('No Jobs')
})

test('show prints the Job, then its Job Executions newest first with duration, result and error', () => {
  const { last: _last, ...job } = sync({})
  const text = formatters.show({
    ...job,
    executions: [
      execution({ startedAt: at(12, 5, 10), endedAt: null, result: null }),
      execution({
        endedAt: at(12, 1, 3),
        result: 'failed',
        error: 'acme/app: GitHub answered 502',
      }),
      execution({ startedAt: at(11, 55, 0), endedAt: at(11, 55, 0, 300) }),
      execution({ startedAt: at(11, 50, 0), endedAt: null, result: 'interrupted' }),
    ],
  })

  expect(text).toBe(
    [
      'NAME       SCHEDULE  STATE   NEXT',
      'task.sync  every 5m  active  2026-10-06 12:05:00',
      '',
      'STARTED              DURATION  RESULT       ERROR',
      '2026-10-06 12:05:10  -         running      -',
      '2026-10-06 12:00:00  1m03s     failed       acme/app: GitHub answered 502',
      '2026-10-06 11:55:00  0.3s      succeeded    -',
      '2026-10-06 11:50:00  -         interrupted  -',
    ].join('\n'),
  )
})

test('show says so when the Job has no Job Executions yet', () => {
  const { last: _last, ...job } = sync({})

  expect(formatters.show({ ...job, executions: [] })).toBe(
    [
      'NAME       SCHEDULE  STATE   NEXT',
      'task.sync  every 5m  active  2026-10-06 12:05:00',
      '',
      'No Job Executions',
    ].join('\n'),
  )
})

test('run says which Job it started and when', () => {
  expect(formatters.run({ name: 'task.sync', startedAt: at(12, 2, 0) })).toBe(
    'started task.sync at 2026-10-06 12:02:00',
  )
})
