import { afterEach, expect, test } from 'bun:test'

import { backendWithTasks, cleanUp, tania } from './testing.ts'

afterEach(cleanUp)

const LOCAL_TIME = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`

test('job list prints task.sync with its schedule', async () => {
  const result = await tania(['job', 'list'], backendWithTasks())

  expect(result).toEqual({
    code: 0,
    stdout: 'NAME       SCHEDULE  STATE   LAST  NEXT\ntask.sync  every 5m  active  -     -\n',
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
