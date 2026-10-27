import { afterEach, expect, mock, setSystemTime, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { WorkbenchChange } from '@monica/workbench/contract'
import { eq } from 'drizzle-orm'

import {
  activeRunsBesides,
  createRunLaunches,
  LAUNCH_TIMEOUT_MS,
  liveRunsOf,
  runToResume,
} from './run.ts'
import { issue, run } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

type Fixture = ReturnType<typeof setup>

const ref = 'acme/app#12'

function started() {
  const fixture = setup()
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

test('a claude started in the Bench stays a started Run when a layout signal follows its hook in the same turn', async () => {
  const fixture = started()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  fixture.workbenchLedger.events.subscribe('change', (change) => {
    if (change.type === 'agentSession') {
      fixture.workbenchLedger.events.publish('change', { type: 'layout' })
    }
  })

  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
})

test('a claude started in the Bench becomes a Run even when more than 100 agentSession signals come around its hook in the same turn', async () => {
  const fixture = setup()
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  const signalOthersOn = (count: number) => (change: WorkbenchChange) => {
    if (change.type !== 'agentSession' || change.sessionId !== 's-1') return
    for (let i = 0; i < count; i++) {
      fixture.workbenchLedger.events.publish('change', {
        type: 'agentSession',
        sessionId: `other-${count}-${i}`,
      })
    }
  }
  fixture.workbenchLedger.events.subscribe('change', signalOthersOn(1))
  fixture.taskLedger.start()
  fixture.workbenchLedger.events.subscribe('change', signalOthersOn(150))

  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
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
  const inBench = await fixture.openTab(await fixture.openBench(ref))
  await fixture.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  const changes: unknown[] = []
  fixture.taskLedger.events.subscribe('change', (change) => changes.push(change))

  fixture.taskLedger.start()

  expect(changes).toContainEqual({ type: 'task', ref })
})

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 9, minute))

const taskIdOf = ({ db }: Fixture) =>
  db.select({ id: issue.id }).from(issue).where(eq(issue.number, 12)).get()!.id

const liveIds = (fixture: Fixture) =>
  liveRunsOf(fixture.db, taskIdOf(fixture)).map((r) => r.sessionId)

const activeIds = (fixture: Fixture, caller?: string) =>
  activeRunsBesides(fixture.db, taskIdOf(fixture), caller).map((r) => r.agentSessionId)

function transcriptOf({ home }: Fixture, sessionId: string, { written = true } = {}) {
  const path = join(home, 'transcripts', `${sessionId}.jsonl`)
  if (written) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  return path
}

test('a Run whose Tab was closed stays live until its exit is recorded, but is no longer an Active Run', async () => {
  const fixture = started()
  const runspaceId = await fixture.openBench(ref)
  const closing = fixture.openTab(runspaceId)
  const ended = fixture.openTab(runspaceId)
  await fixture.hook(closing, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(ended, 's-2', 'SessionStart', { source: 'startup' })
  await fixture.hook(ended, 's-2', 'SessionEnd', { reason: 'prompt_input_exit' })

  expect(liveIds(fixture)).toEqual(['s-1'])
  expect(activeIds(fixture)).toEqual(['s-1'])

  await fixture.closeTab(closing)

  expect(liveIds(fixture)).toEqual(['s-1'])
  expect(activeIds(fixture)).toEqual([])
})

test('the Active Runs leave out the Run in the Terminal Session that asks', async () => {
  const fixture = started()
  const runspaceId = await fixture.openBench(ref)
  const caller = fixture.openTab(runspaceId)
  const other = fixture.openTab(runspaceId)
  await fixture.hook(caller, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(other, 's-2', 'SessionStart', { source: 'startup' })

  expect(activeIds(fixture, caller)).toEqual(['s-2'])
})

test('a Run launch holds from opening its Tab until the claude in it becomes a Run', async () => {
  const fixture = started()
  const launches = createRunLaunches()
  const terminalSessionId = fixture.openTab(await fixture.openBench(ref))
  launches.begin(taskIdOf(fixture), terminalSessionId)

  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(true)

  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
})

test('a Run launch ends once its Tab is closed, before the exit is recorded', async () => {
  const fixture = started()
  const launches = createRunLaunches()
  const terminalSessionId = fixture.openTab(await fixture.openBench(ref))
  launches.begin(taskIdOf(fixture), terminalSessionId)

  await fixture.closeTab(terminalSessionId)

  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
})

test('a Run launch ends once its Terminal Session exits', async () => {
  const fixture = started()
  const launches = createRunLaunches()
  const terminalSessionId = fixture.openTab(await fixture.openBench(ref))
  launches.begin(taskIdOf(fixture), terminalSessionId)

  await fixture.exit(terminalSessionId)

  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
})

test('a Run launch whose claude neither becomes a Run nor ends lapses 60 seconds after it began, and does not come back', async () => {
  const fixture = started()
  const launches = createRunLaunches()
  const terminalSessionId = fixture.openTab(await fixture.openBench(ref))
  const began = Date.now()
  launches.begin(taskIdOf(fixture), terminalSessionId)

  setSystemTime(new Date(began + LAUNCH_TIMEOUT_MS - 1_000))
  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(true)
  setSystemTime(new Date(began + LAUNCH_TIMEOUT_MS + 1))
  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
  setSystemTime(new Date(began))
  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
})

test('a Run launch ends when it is ended', async () => {
  const fixture = started()
  const launches = createRunLaunches()
  const terminalSessionId = fixture.openTab(await fixture.openBench(ref))
  launches.begin(taskIdOf(fixture), terminalSessionId)

  launches.end(taskIdOf(fixture))

  expect(launches.hasRunLaunch(fixture.db, taskIdOf(fixture))).toBe(false)
})

test('the Run to resume is the latest one since the Bench whose transcript is still there', async () => {
  const fixture = started()
  setSystemTime(at(0))
  const runspaceId = await fixture.openBench(ref)
  const claudeAt = async (minute: number, sessionId: string, fields: object) => {
    setSystemTime(at(minute))
    const terminalSessionId = fixture.openTab(runspaceId)
    await fixture.hook(terminalSessionId, sessionId, 'SessionStart', {
      source: 'startup',
      ...fields,
    })
    return terminalSessionId
  }
  const before = await claudeAt(1, 's-before', {
    transcript_path: transcriptOf(fixture, 's-before'),
  })
  const gone = await claudeAt(3, 's-gone', {
    transcript_path: transcriptOf(fixture, 's-gone', { written: false }),
  })
  await claudeAt(4, 's-kept', { transcript_path: transcriptOf(fixture, 's-kept') })
  setSystemTime(at(8))
  await fixture.hook(gone, 's-gone', 'UserPromptSubmit', { prompt: 'go on' })
  setSystemTime(at(9))
  await fixture.hook(before, 's-before', 'UserPromptSubmit', { prompt: 'go on' })

  expect(runToResume(fixture.db, taskIdOf(fixture), { createdAt: at(0) })?.agentSessionId).toBe(
    's-before',
  )
  expect(runToResume(fixture.db, taskIdOf(fixture), { createdAt: at(2) })?.agentSessionId).toBe(
    's-kept',
  )
})
