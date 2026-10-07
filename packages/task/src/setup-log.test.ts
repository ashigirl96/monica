import { afterEach, expect, mock, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { systemJobs } from './server.ts'
import { cleanUp, failure, onCleanup, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'
const DAY = 24 * 60 * 60_000

function lastWritten(path: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * DAY)
  utimesSync(path, at, at)
}

function writeLog(home: string, path: string, daysAgo: number): string {
  const log = join(home, 'logs/setup', path)
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, 'tania: exit 1\n')
  lastWritten(log, daysAgo)
  return log
}

async function benched() {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.client.track({ ref })
  await fixture.client.run({ ref })
  return { ...fixture, log: join(fixture.home, 'logs/setup/acme/app/issue-12.log') }
}

test('the setup log of a closed Task goes 14 days after it was last written, and so do the directories it leaves empty', async () => {
  const { client, taskLedger, home, log } = await benched()
  await client.close({ ref })
  lastWritten(log, 15)

  await taskLedger.cleanSetupLogs()

  expect(existsSync(log)).toBe(false)
  expect(existsSync(join(home, 'logs/setup/acme'))).toBe(false)
})

test('the log of a Task with a Bench stays however old it is, and so does a log written less than 14 days ago', async () => {
  const { taskLedger, home, log } = await benched()
  lastWritten(log, 15)
  const recent = writeLog(home, 'acme/lib/issue-3.log', 13)

  await taskLedger.cleanSetupLogs()

  expect(existsSync(log)).toBe(true)
  expect(existsSync(recent)).toBe(true)
})

test('the log left under the old name of a renamed repo is no Task’s, so it goes 14 days after it was last written', async () => {
  const { github, client, taskLedger, log } = await benched()
  github.renameRepo('acme/app', 'acme/application')
  await client.sync({})
  lastWritten(log, 15)

  await taskLedger.cleanSetupLogs()

  expect(existsSync(log)).toBe(false)
})

test('the log of a Task with a Bench stays when the repo was renamed only in case', async () => {
  const { github, client, taskLedger, log } = await benched()
  github.renameRepo('acme/app', 'Acme/App')
  await client.sync({})
  lastWritten(log, 15)

  await taskLedger.cleanSetupLogs()

  expect(existsSync(log)).toBe(true)
})

test('a home no setup has written a log in yet has nothing to clean', async () => {
  const { taskLedger, home } = setup()

  await taskLedger.cleanSetupLogs()

  expect(existsSync(join(home, 'logs/setup'))).toBe(false)
})

test('logs it cannot remove fail the clean-up on one line after the other logs are gone', async () => {
  const { taskLedger, home } = setup()
  const stuck = ['acme/app/issue-1.log', 'beta/app/issue-2.log'].map((path) => {
    const log = writeLog(home, path, 15)
    chmodSync(dirname(log), 0o555)
    onCleanup(() => chmodSync(dirname(log), 0o755))
    return log
  })
  const removable = writeLog(home, 'zeta/lib/issue-3.log', 15)

  const error = await failure(taskLedger.cleanSetupLogs())

  expect(existsSync(removable)).toBe(false)
  expect(stuck.filter((log) => existsSync(log))).toEqual(stuck)
  expect(error.message).toBe(
    `could not remove the setup logs: ${stuck.map((log) => `EACCES: permission denied, unlink '${log}'`).join('; ')}`,
  )
})

test('the system Job task.setup-log-cleanup cleans the setup logs', async () => {
  const { taskLedger, home } = setup()
  const log = writeLog(home, 'acme/app/issue-12.log', 15)

  await systemJobs(taskLedger)
    .find((job) => job.name === 'task.setup-log-cleanup')!
    .run()

  expect(existsSync(log)).toBe(false)
})
