import { afterEach, expect, mock, test } from 'bun:test'

import { nameAgentSession } from './server.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'

async function withBench({ start }: { start: boolean }) {
  const fixture = setup()
  if (start) fixture.taskLedger.start()
  return { ...fixture, benchRunspace: await fixture.openBench(ref) }
}

test("current names the Task of the Run of the calling Tab's claude, even outside the Bench", async () => {
  const fixture = await withBench({ start: true })
  const inBench = await fixture.openTab(fixture.benchRunspace)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(outside, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(await fixture.client.current({ terminalSessionId: outside })).toEqual({
    ref,
    title: 'Ship it',
    displayState: expect.objectContaining({ state: 'running' }),
    agentSessionId: 's-1',
    source: 'run',
  })
})

test('current names the Task of the Bench the calling Tab is in when its claude is no Run', async () => {
  const fixture = await withBench({ start: true })
  const inBench = await fixture.openTab(fixture.benchRunspace)

  expect(await fixture.client.current({ terminalSessionId: inBench })).toEqual({
    ref,
    title: 'Ship it',
    displayState: { state: 'ended' },
    agentSessionId: null,
    source: 'bench',
  })
})

test('current fails for a Tab with no Run outside a Bench, and outside a Tab', async () => {
  const fixture = await withBench({ start: true })
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  expect((await failure(fixture.client.current({ terminalSessionId: outside }))).code).toBe(
    'NOT_FOUND',
  )
  expect((await failure(fixture.client.current({}))).code).toBe('BAD_REQUEST')
})

test('nameAgentSession names the Task of the Run, even after its claude moves out of the Bench', async () => {
  const fixture = await withBench({ start: true })
  const inBench = await fixture.openTab(fixture.benchRunspace)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(outside, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(nameAgentSession(fixture.db, 's-1')).toBe('app#12 Ship it')
})

test('nameAgentSession names the Task of the Bench for a claude in it that is no Run yet', async () => {
  const fixture = await withBench({ start: false })
  const inBench = await fixture.openTab(fixture.benchRunspace)
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })

  expect(nameAgentSession(fixture.db, 's-1')).toBe('app#12 Ship it')
})

test('nameAgentSession has no name for a claude that has nothing to do with a Task', async () => {
  const fixture = await withBench({ start: true })
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  expect(nameAgentSession(fixture.db, 's-1')).toBeNull()
})

test('the notification for a Run waiting on the user is titled with its Task', async () => {
  const fixture = await withBench({ start: true })
  const inBench = await fixture.openTab(fixture.benchRunspace)
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(inBench, 's-1', 'UserPromptSubmit', { prompt: 'ship it' })

  await fixture.hook(inBench, 's-1', 'PermissionRequest', {
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
  })

  expect(fixture.notifications).toEqual([
    { title: 'app#12 Ship it', body: '許可: Bash', terminalSessionId: inBench },
  ])
})
