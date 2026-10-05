import { afterEach, expect, mock, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { issue, run } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

type Fixture = ReturnType<typeof setup>

const ref = 'acme/app#12'

function started() {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  fixture.taskLedger.start()
  return fixture
}

function runsOf({ db }: Fixture) {
  return db
    .select({ number: issue.number, agentSessionId: run.agentSessionId, origin: run.origin })
    .from(run)
    .innerJoin(issue, eq(issue.id, run.taskIssueId))
    .orderBy(run.id)
    .all()
}

async function stateOf({ client }: Fixture, taskRef = ref) {
  return (await client.list({})).tasks.find((t) => t.ref === taskRef)!.displayState
}

test('a claude started in a Tab of the Bench becomes a Run of the Task, waiting idle', async () => {
  const fixture = started()
  const terminalSessionId = await fixture.openTab(await fixture.openBench(ref))

  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
  expect(await stateOf(fixture)).toEqual({
    state: 'waiting',
    reason: 'idle',
    since: expect.any(Date),
    liveRuns: [
      { agentSessionId: 's-1', state: 'waiting', reason: 'idle', since: expect.any(Date) },
    ],
  })
})

test('a Run stays with its Task while its claude moves out of the Bench, until it ends', async () => {
  const fixture = started()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })

  await fixture.hook(outside, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
  expect(await stateOf(fixture)).toMatchObject({ state: 'running' })

  await fixture.hook(outside, 's-1', 'SessionEnd', { reason: 'prompt_input_exit' })

  expect(await stateOf(fixture)).toEqual({ state: 'ended' })
})

test('a claude that moves into a Tab of the Bench becomes a Run of the Task then', async () => {
  const fixture = started()
  const outside = await fixture.openTabOutsideBench()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  expect(runsOf(fixture)).toEqual([])

  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'resume' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
})

test('a Run of one Task stays with it when its claude moves into the Bench of another', async () => {
  const fixture = started()
  const first = await fixture.openTab(await fixture.openBench(ref))
  const second = await fixture.openTab(await fixture.openBench('acme/app#13', 'Next'))
  await fixture.hook(first, 's-1', 'SessionStart', { source: 'startup' })

  await fixture.hook(second, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
  expect(await stateOf(fixture, 'acme/app#13')).toEqual({ state: 'ended' })
})

test('start makes Runs of the live Agent Sessions already in a Bench, but not of the ended ones', async () => {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  const runspaceId = await fixture.openBench(ref)
  const live = await fixture.openTab(runspaceId)
  const gone = await fixture.openTab(runspaceId)
  await fixture.hook(live, 's-live', 'SessionStart', { source: 'startup' })
  await fixture.hook(gone, 's-gone', 'SessionStart', { source: 'startup' })
  await fixture.hook(gone, 's-gone', 'SessionEnd', { reason: 'prompt_input_exit' })

  expect(runsOf(fixture)).toEqual([])

  fixture.taskLedger.start()

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-live', origin: 'started' }])
})

test('a claude begun in the Bench while the Backend was away becomes a Run on its first hook after start', async () => {
  const fixture = started()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  fixture.restartTaskLedger().taskLedger.start()

  await fixture.hook(inBench, 's-1', 'UserPromptSubmit', { prompt: 'after the restart' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
})

test('a Task with two live Runs shows the one that waits first and lists both', async () => {
  const fixture = started()
  const runspaceId = await fixture.openBench(ref)
  const first = await fixture.openTab(runspaceId)
  const second = await fixture.openTab(runspaceId)
  await fixture.hook(first, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(first, 's-1', 'UserPromptSubmit', { prompt: 'build it' })
  await fixture.hook(second, 's-2', 'SessionStart', { source: 'startup' })
  await fixture.hook(second, 's-2', 'UserPromptSubmit', { prompt: 'test it' })

  await fixture.hook(second, 's-2', 'PermissionRequest', {
    tool_name: 'Bash',
    tool_input: { command: 'bun test' },
  })

  expect(await stateOf(fixture)).toMatchObject({
    state: 'waiting',
    reason: 'permission',
    tool: 'Bash',
    liveRuns: [
      { agentSessionId: 's-2', state: 'waiting', reason: 'permission' },
      { agentSessionId: 's-1', state: 'running' },
    ],
  })
})

test("task.changes signals the Task when its Run is made and whenever the Run's claude changes", async () => {
  const fixture = started()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  const outside = await fixture.openTabOutsideBench()
  const changes: unknown[] = []
  fixture.taskLedger.events.subscribe('change', (change) => changes.push(change))

  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(inBench, 's-1', 'UserPromptSubmit', { prompt: 'go' })
  await fixture.hook(outside, 's-2', 'SessionStart', { source: 'startup' })

  expect(changes).toEqual([
    { type: 'task', ref },
    { type: 'task', ref },
  ])
})

test('start signals the Tasks whose Runs it makes', async () => {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  const changes: unknown[] = []
  fixture.taskLedger.events.subscribe('change', (change) => changes.push(change))

  fixture.taskLedger.start()

  expect(changes).toContainEqual({ type: 'task', ref })
})
