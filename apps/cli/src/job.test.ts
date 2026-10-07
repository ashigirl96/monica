import { afterEach, expect, onTestFinished, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backendWithTasks, cleanUp, tania } from './testing.ts'

afterEach(cleanUp)

const LOCAL_TIME = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`

test('job list prints the system Jobs with their schedules', async () => {
  const result = await tania(['job', 'list'], backendWithTasks())

  expect(result).toEqual({
    code: 0,
    stdout: [
      'NAME                    SCHEDULE   STATE   LAST  NEXT',
      'task.sync               every 5m   active  -     -',
      'task.setup-log-cleanup  every 24h  active  -     -',
      'note.image-cleanup      every 24h  active  -     -',
      '',
    ].join('\n'),
    stderr: '',
  })
})

test('job run starts task.sync, and job show gives the failed sync with its error on one line', async () => {
  const connect = backendWithTasks()

  const ran = await tania(['job', 'run', 'task.sync'], connect)
  let shown = await tania(['job', 'show', 'task.sync'], connect)
  for (let tries = 0; shown.stdout.includes('running'); tries++) {
    if (tries > 200) throw new Error(`task.sync never ended:\n${shown.stdout}`)
    await Bun.sleep(5)
    shown = await tania(['job', 'show', 'task.sync'], connect)
  }

  expect(ran.code).toBe(0)
  expect(ran.stdout).toMatch(new RegExp(`^started task\\.sync at ${LOCAL_TIME}\\n$`))
  expect(shown.code).toBe(0)
  expect(shown.stdout.split('\n').slice(3, 5)).toEqual([
    'STARTED              DURATION  RESULT  ERROR',
    expect.stringMatching(new RegExp(`^${LOCAL_TIME}  \\d+\\.\\ds +failed  .*gh auth token`)),
  ])
})

test('job show refuses a name no Job has with NOT_FOUND and exit 1', async () => {
  const result = await tania(['job', 'show', 'task.synk'], backendWithTasks())

  expect(result).toEqual({ code: 1, stdout: '', stderr: 'NOT_FOUND: no Job is named task.synk\n' })
})

test('job add registers a user Job that job list shows with its cron expression', async () => {
  const connect = backendWithTasks()
  const cwd = mkdtempSync(join(tmpdir(), 'tania-cli-job-'))
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }))

  const added = await tania(
    [
      'job',
      'add',
      'dreaming',
      '--schedule',
      '0 3 * * *',
      '--command',
      'echo "$HOME"',
      '--cwd',
      cwd,
      '--timeout',
      '30m',
    ],
    connect,
  )
  const listed = await tania(['job', 'list'], connect)
  const shown = await tania(['job', 'show', 'dreaming', '--format', 'json'], connect)

  expect(added).toEqual({
    code: 0,
    stdout: expect.stringMatching(/^added dreaming; it runs next at \d{4}-\d\d-\d\d 03:00:00\n$/),
    stderr: '',
  })
  expect(listed.stdout.split('\n').find((line) => line.startsWith('dreaming '))).toMatch(
    /^dreaming +0 3 \* \* \* +active +- +/,
  )
  expect(JSON.parse(shown.stdout).shell).toEqual({
    command: 'echo "$HOME"',
    cwd,
    timeoutMs: 30 * 60_000,
  })
})

test('job add refuses a name with . before calling the Backend, with BAD_REQUEST and exit 1', async () => {
  const result = await tania(
    ['job', 'add', 'task.sync', '--schedule', '0 3 * * *', '--command', 'true'],
    backendWithTasks(),
  )

  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr: expect.stringMatching(/^BAD_REQUEST: .*names with \. are kept for system Jobs.*\n$/),
  })
})

test('job pause refuses a system Job, and completes only the user Jobs', async () => {
  const connect = backendWithTasks()
  await tania(['job', 'add', 'dreaming', '--schedule', '0 3 * * *', '--command', 'true'], connect)

  const refused = await tania(['job', 'pause', 'task.sync'], connect)
  const completed = await tania(['__complete', '--', 'job', 'pause', ''], connect)

  expect(refused).toEqual({
    code: 1,
    stdout: '',
    stderr: 'BAD_REQUEST: task.sync is a system Job, so it cannot be paused\n',
  })
  expect(completed.stdout).toBe('dreaming:0 3 * * *\n')
})
