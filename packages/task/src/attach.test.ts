import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tab } from '@monica/workbench/schema'
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
  fixture.taskLedger.start()
  return fixture
}

async function trackedWithoutBench() {
  const fixture = started()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
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

function moveByTabMove(fixture: Fixture, terminalSessionId: string, runspaceId: string) {
  return fixture.workbenchClient.tab.move({
    id: fixture.tabIdOf(terminalSessionId),
    runspaceId,
    index: 0,
  })
}

test('a claude in a Tab moved into the Bench by tab.move becomes a Run of the Task, attached', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  await moveByTabMove(fixture, outside, benchRunspace)

  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'attached' }])
})

test('a Tab moved into the Bench by tab.move moves even when its claude is a Run of another Task, which stays its only Run', async () => {
  const fixture = started()
  const other = await fixture.openTab(await fixture.openBench('acme/app#13', 'Next'))
  const benchRunspace = await fixture.openBench(ref)
  await fixture.hook(other, 's-1', 'SessionStart', { source: 'startup' })

  await moveByTabMove(fixture, other, benchRunspace)

  expect(runspaceOfTab(fixture, other)).toBe(benchRunspace)
  expect(runsOf(fixture)).toEqual([{ number: 13, agentSessionId: 's-1', origin: 'started' }])
})

test('attach moves the calling Tab into the Bench and makes its claude a Run that list shows', async () => {
  const fixture = started()
  const benchRunspace = await fixture.openBench(ref)
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })
  const requestsBefore = fixture.github.requests.length

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(fixture.github.requests).toHaveLength(requestsBefore)
  expect(output).toEqual({
    ref,
    title: 'Ship it',
    tracked: false,
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
  await moveByTabMove(fixture, tabbed, runspaceOfTab(fixture, await fixture.openTabOutsideBench())!)

  const output = await fixture.client.attach({ ref, terminalSessionId: tabbed })

  expect(output).toMatchObject({ runCreated: false, agentSessionId: 's-1' })
  expect(runspaceOfTab(fixture, tabbed)).toBe(benchRunspace)
  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'started' }])
})

test("attach opens the Bench of a Task that has none in place on the Repo's checkout, ready and without a setup or a clone", async () => {
  const fixture = await trackedWithoutBench()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const setupScript = join(fixture.ghq.checkout('acme/app'), '.monica/setup.sh')
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

test('attach moves the Tab into the Bench a run opened while attach looked up ghq root', async () => {
  const fixture = await trackedWithoutBench()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const root = await fixture.ghq.client.root()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  spyOn(fixture.ghq.client, 'root').mockImplementationOnce(() => {
    asked.resolve()
    return answer.promise
  })
  const outside = await fixture.openTabOutsideBench()

  const attaching = fixture.client.attach({ ref, terminalSessionId: outside })
  await asked.promise
  await fixture.client.run({ ref, inPlace: true })
  answer.resolve(root)

  expect(await attaching).toMatchObject({ ref, benchCreated: false })
  const benches = fixture.db.select().from(bench).all()
  expect(benches).toHaveLength(1)
  expect(runspaceOfTab(fixture, outside)).toBe(benches[0]!.runspaceId)
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

test('attach refuses a Terminal Session whose Tab was closed, a call from outside a Tab, a closed Task, and a ref GitHub does not return', async () => {
  const fixture = started()
  await fixture.openBench(ref)
  const closed = await fixture.openTabOutsideBench()
  await fixture.workbenchClient.tab.close({ id: fixture.tabIdOf(closed) })
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

async function untrackedWithCheckout(repo = 'acme/app') {
  const fixture = started()
  fixture.github.issue('acme/app#4', { title: 'Schema first' })
  fixture.github.issue('acme/app#10', { title: 'Epic' })
  fixture.github.issue(ref, {
    title: 'Ship it',
    labels: ['bug'],
    parent: 'acme/app#10',
    blockedBy: ['acme/app#4'],
  })
  mkdirSync(fixture.ghq.checkout(repo), { recursive: true })
  return fixture
}

test("attach of an untracked Issue tracks it, opens its Bench in place on the Repo's checkout and makes the Tab's claude a Run, attached", async () => {
  const fixture = await untrackedWithCheckout()
  const outside = await fixture.openTabOutsideBench()
  await fixture.hook(outside, 's-1', 'SessionStart', { source: 'startup' })
  const changes: unknown[] = []
  fixture.taskLedger.events.subscribe('change', (change) => changes.push(change))

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(output).toEqual({
    ref,
    title: 'Ship it',
    tracked: true,
    benchCreated: true,
    runCreated: true,
    agentSessionId: 's-1',
  })
  expect(fixture.db.select().from(bench).get()).toMatchObject({
    runspaceId: runspaceOfTab(fixture, outside),
    cwd: fixture.ghq.checkout('acme/app'),
    mode: 'in_place',
  })
  expect(runsOf(fixture)).toEqual([{ number: 12, agentSessionId: 's-1', origin: 'attached' }])
  expect((await fixture.client.list({})).tasks).toMatchObject([
    { ref, title: 'Ship it', blockers: ['acme/app#4'] },
  ])
  const copied = fixture.db.select().from(issue).where(eq(issue.number, 12)).get()!
  expect(copied.labels).toEqual(['bug'])
  expect(
    fixture.db
      .select({ number: issue.number })
      .from(issue)
      .where(eq(issue.id, copied.parentId!))
      .get(),
  ).toEqual({ number: 10 })
  expect(await fixture.client.current({ terminalSessionId: outside })).toMatchObject({ ref })
  expect(changes).toContainEqual({ type: 'task', ref })
})

test('attach of an untracked Issue moves a Tab with no claude into its new Bench', async () => {
  const fixture = await untrackedWithCheckout()
  const outside = await fixture.openTabOutsideBench()

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(output).toMatchObject({ tracked: true, benchCreated: true, agentSessionId: null })
  expect(runspaceOfTab(fixture, outside)).toBe(fixture.db.select().from(bench).get()!.runspaceId)
})

test("attach asked by a repo's old name for an untracked Issue tracks it under the new name and opens the Bench on that name's checkout", async () => {
  const fixture = await untrackedWithCheckout('acme/renamed')
  fixture.github.renameRepo('acme/app', 'acme/renamed')
  const outside = await fixture.openTabOutsideBench()

  const output = await fixture.client.attach({ ref, terminalSessionId: outside })

  expect(output).toMatchObject({ ref: 'acme/renamed#12', tracked: true, benchCreated: true })
  expect(fixture.db.select().from(bench).get()).toMatchObject({
    cwd: fixture.ghq.checkout('acme/renamed'),
  })
})

test('attach refuses an untracked Issue whose Repo is not cloned, and the Issue stays tracked', async () => {
  const fixture = started()
  fixture.github.issue(ref, { title: 'Ship it' })
  const outside = await fixture.openTabOutsideBench()
  const before = runspaceOfTab(fixture, outside)

  const error = await failure(fixture.client.attach({ ref, terminalSessionId: outside }))

  expect(error.code).toBe('BAD_REQUEST')
  expect((await fixture.client.list({})).tasks).toMatchObject([{ ref }])
  expect(fixture.db.select().from(bench).all()).toEqual([])
  expect(runspaceOfTab(fixture, outside)).toBe(before)
})

test('attach refuses an untracked Issue for a Tab whose claude is a Run of another Task, and the Issue stays tracked', async () => {
  const fixture = await untrackedWithCheckout()
  const other = await fixture.openTab(await fixture.openBench('acme/app#13', 'Next'))
  await fixture.hook(other, 's-1', 'SessionStart', { source: 'startup' })

  const error = await failure(fixture.client.attach({ ref, terminalSessionId: other }))

  expect(error.code).toBe('CONFLICT')
  expect((await fixture.client.list({})).tasks.map((t) => t.ref)).toContain(ref)
  expect(runsOf(fixture)).toEqual([{ number: 13, agentSessionId: 's-1', origin: 'started' }])
})

test('attach from outside a Tab refuses an untracked Issue with BAD_REQUEST before it asks GitHub', async () => {
  const fixture = await untrackedWithCheckout()

  const error = await failure(fixture.client.attach({ ref }))

  expect(error.code).toBe('BAD_REQUEST')
  expect(fixture.github.requests).toEqual([])
  expect((await fixture.client.list({})).tasks).toEqual([])
})
