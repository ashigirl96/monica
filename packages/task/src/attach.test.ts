import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tab } from '@tania/workbench/schema'
import { eq } from 'drizzle-orm'

import { bench, issue, run, task } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

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

async function trackedWithoutBench() {
  const fixture = started()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.client.track({ ref })
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

function runspaceOfTab({ db }: Fixture, terminalSessionId: string) {
  return db
    .select({ runspaceId: tab.runspaceId })
    .from(tab)
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()?.runspaceId
}

function tabIdOf({ db }: Fixture, terminalSessionId: string) {
  return db
    .select({ id: tab.id })
    .from(tab)
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()!.id
}

// webview の drag は tab.move を呼ぶ。
function drag(fixture: Fixture, terminalSessionId: string, runspaceId: string) {
  return fixture.workbenchClient.tab.move({
    id: tabIdOf(fixture, terminalSessionId),
    runspaceId,
    index: 0,
  })
}

test('a claude in a Tab dragged into the Bench becomes a Run of the Task, attached', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  await drag(fixture, outside, benchRunspace)

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'attached' }])
})

test('a Tab dragged into the Bench moves even when its claude is a Run of another Task, which stays its only Run', async () => {
  const fixture = started()
  const other = await fixture.openTab(await fixture.openBench('acme/app#13', 'Next'))
  const benchRunspace = await fixture.openBench(ref)
  await fixture.hook(other, 's-1', 'SessionStart', { source: 'startup' })

  await drag(fixture, other, benchRunspace)

  expect(runspaceOfTab(fixture, other)).toBe(benchRunspace)
  expect(runsOf(fixture)).toEqual([{ number: 13, agentSessionId: 's-1', origin: 'started' }])
})

test('a layout signal after attach leaves the Run attach made alone, without a failed second insert', async () => {
  const fixture = started()
  await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.client.attach({ ref, terminalSessionId: outside })
  const errors = spyOn(console, 'error')

  await fixture.workbenchClient.tab.setCwd({
    id: tabIdOf(fixture, outside),
    cwd: '/work/elsewhere',
  })

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'attached' }])
  expect(errors).not.toHaveBeenCalled()
})

test('attach moves the calling Tab into the Bench and makes its claude a Run that list shows', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(output).toEqual({
    ref,
    title: 'Ship it',
    benchCreated: false,
    runCreated: true,
    agentSessionId: 's-1',
  })
  expect(runspaceOfTab(fixture, outside)).toBe(benchRunspace)
  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'attached' }])
  expect((await fixture.client.list({})).tasks[0]!.displayState).toMatchObject({
    state: 'waiting',
    reason: 'idle',
    liveRuns: [{ agentSessionId: 's-1' }],
  })
})

test('task.changes signals the Task when attach moves a Tab into its Bench, even one with no claude', async () => {
  const fixture = started()
  await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  const changes: unknown[] = []
  fixture.taskLedger.events.subscribe('change', (change) => changes.push(change))

  await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(changes).toEqual([{ type: 'task', ref }])
})

test('attach succeeds without changing anything for a Tab already in the Bench', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const first = await fixture.openTab(benchRunspace)
  await fixture.openTab(benchRunspace)
  await fixture.hook(first, 's-1', 'SessionStart', { source: 'startup' })
  const layoutBefore = await fixture.workbenchClient.layout.get()
  const changes: unknown[] = []
  fixture.workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  const output = await fixture.client.attach({ ref, terminalSessionId: first })

  expect(output).toMatchObject({ benchCreated: false, runCreated: false, agentSessionId: 's-1' })
  expect(await fixture.workbenchClient.layout.get()).toEqual(layoutBefore)
  expect(changes).toEqual([])
})

test('attach brings back a Tab whose claude is already a Run of the Task without a second Run', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const tabbed = await fixture.openTab(benchRunspace)
  await fixture.hook(tabbed, 's-1', 'SessionStart', { source: 'startup' })
  await drag(fixture, tabbed, runspaceOfTab(fixture, await fixture.openTabOutsideBench())!)

  const output = await fixture.client.attach({ ref, terminalSessionId: tabbed })

  expect(output).toMatchObject({ runCreated: false, agentSessionId: 's-1' })
  expect(runspaceOfTab(fixture, tabbed)).toBe(benchRunspace)
  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
})

test("attach opens the Bench of a Task that has none in place on the Repo's checkout, ready and without a setup or a clone", async () => {
  const fixture = await trackedWithoutBench()
  fixture.ghq.clone('acme/app')
  const setupScript = join(fixture.ghq.checkout('acme/app'), '.tania/setup.sh')
  mkdirSync(join(setupScript, '..'))
  writeFileSync(setupScript, '#!/bin/sh\ntouch .setup-ran\n', { mode: 0o755 })
  const outside = await fixture.openTabOutsideBench()

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(output).toMatchObject({ benchCreated: true, runCreated: false, agentSessionId: null })
  expect(fixture.db.select().from(bench).get()).toMatchObject({
    runspaceId: runspaceOfTab(fixture, outside),
    cwd: fixture.ghq.checkout('acme/app'),
    mode: 'in_place',
    setupState: 'ready',
  })
  expect(fixture.ghq.gets).toEqual([])
  expect(existsSync(join(fixture.ghq.checkout('acme/app'), '.setup-ran'))).toBe(false)
  expect((await fixture.client.list({})).tasks[0]!.displayState).toEqual({ state: 'ended' })
})

test("attach opens the Bench on the checkout of the Repo's new name when the Repo is renamed while it looks up ghq root", async () => {
  const fixture = await trackedWithoutBench()
  const renamed = fixture.ghq.checkout('acme/renamed')
  mkdirSync(renamed, { recursive: true })
  const root = await fixture.ghq.client.root()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  spyOn(fixture.ghq.client, 'root').mockImplementation(() => {
    asked.resolve()
    return answer.promise
  })
  const outside = await fixture.openTabOutsideBench()

  const attaching = fixture.client.attach({ ref, terminalSessionId: outside })
  await asked.promise
  fixture.db.update(issue).set({ repo: 'acme/renamed' }).run()
  answer.resolve(root)

  expect(await attaching).toMatchObject({ ref: 'acme/renamed#12', benchCreated: true })
  expect(fixture.db.select().from(bench).get()).toMatchObject({ cwd: renamed })
})

test('attach refuses a Task that has no Bench and whose Repo is not cloned, changing nothing', async () => {
  const fixture = await trackedWithoutBench()
  const outside = await fixture.openTabOutsideBench()
  const before = runspaceOfTab(fixture, outside)

  const error = await failure(fixture.client.attach({ ref, terminalSessionId: outside }))

  expect(error.code).toBe('BAD_REQUEST')
  expect(error.message).toContain('ghq get acme/app')
  expect(fixture.db.select().from(bench).all()).toEqual([])
  expect(runspaceOfTab(fixture, outside)).toBe(before)
})

test('attach refuses a Tab whose claude is a Run of another Task, changing nothing', async () => {
  const fixture = started()
  const other = await fixture.openTab(await fixture.openBench('acme/app#13', 'Next'))
  await fixture.openBench(ref)
  await fixture.hook(other, 's-1', 'SessionStart', { source: 'startup' })
  const before = runspaceOfTab(fixture, other)

  const error = await failure(fixture.client.attach({ ref, terminalSessionId: other }))

  expect(error).toMatchObject({
    code: 'CONFLICT',
    message: expect.stringContaining('acme/app#13'),
  })
  expect(runspaceOfTab(fixture, other)).toBe(before)
  expect(runsOf(fixture)).toEqual([{ number: 13, agentSessionId: 's-1', origin: 'started' }])
})

test('attach refuses a Terminal Session whose Tab was closed, a call from outside a Tab, a closed Task, and an untracked one', async () => {
  const fixture = started()
  await fixture.openBench(ref)
  const closed = await fixture.openTabOutsideBench()
  await fixture.workbenchClient.tab.close({ id: tabIdOf(fixture, closed) })
  const outside = await fixture.openTabOutsideBench()

  expect((await failure(fixture.client.attach({ ref, terminalSessionId: closed }))).code).toBe(
    'BAD_REQUEST',
  )
  expect((await failure(fixture.client.attach({ ref }))).code).toBe('BAD_REQUEST')
  expect(
    (await failure(fixture.client.attach({ ref: 'acme/app#99', terminalSessionId: outside }))).code,
  ).toBe('NOT_FOUND')
  fixture.db.update(task).set({ closedAt: new Date() }).run()
  expect((await failure(fixture.client.attach({ ref, terminalSessionId: outside }))).code).toBe(
    'BAD_REQUEST',
  )
})
