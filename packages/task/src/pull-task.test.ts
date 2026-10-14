import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { isIssue } from './copy.ts'
import { TaskStateRefusal } from './open-task.ts'
import { pullOpen, pullOrTrack, pullToClose, pullToReopen, refresh } from './pull-task.ts'
import { parseRef } from './ref.ts'
import { issue, task } from './schema.ts'
import { internals } from './task.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  cleanUp()
})

const ref = 'acme/app#12'

function ledger() {
  const fixture = setup()
  return { ...fixture, deps: internals(fixture.taskLedger) }
}

async function trackedTask() {
  const fixture = ledger()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  return fixture
}

function closeTask({ db }: { db: ReturnType<typeof setup>['db'] }) {
  db.update(task).set({ closedAt: new Date() }).run()
}

async function refusal(run: () => unknown) {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to fail')
}

test('pullOrTrack tracks an untracked ref and returns the Task by the name GitHub has now, even when asked by the old name', async () => {
  const fixture = ledger()
  fixture.github.issue(ref, { title: 'Ship it' })
  fixture.github.renameRepo('acme/app', 'acme/renamed')

  const { found, tracked } = await pullOrTrack(fixture.deps, parseRef(ref))

  expect(tracked).toBe(true)
  expect(found.issue).toMatchObject({ repo: 'acme/renamed', number: 12, title: 'Ship it' })
  expect(fixture.db.select().from(task).all()).toHaveLength(1)
})

test('pullOrTrack returns a tracked Task without tracking it again', async () => {
  const fixture = await trackedTask()

  const { found, tracked } = await pullOrTrack(fixture.deps, parseRef(ref))

  expect(tracked).toBe(false)
  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
})

test('pullOrTrack refuses a ref GitHub does not return with NOT_FOUND, and neither tracks nor copies it', async () => {
  const fixture = ledger()

  const error = await failure(pullOrTrack(fixture.deps, parseRef('acme/app#99')))

  expect(error.code).toBe('NOT_FOUND')
  expect(fixture.db.select().from(task).all()).toEqual([])
  expect(fixture.db.select().from(issue).all()).toEqual([])
})

test('pullOrTrack finds a Task by node ID even when its copy still has the old name', async () => {
  const fixture = await trackedTask()
  const { nodeId } = fixture.db.select({ nodeId: issue.nodeId }).from(issue).get()!
  fixture.github.renameRepo('acme/app', 'acme/renamed')

  const { found, tracked } = await pullOrTrack(fixture.deps, parseRef('acme/renamed#12'), nodeId!)

  expect(tracked).toBe(false)
  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
})

test('pullOrTrack refuses a closed Task with TaskStateRefusal, pointing to reopen', async () => {
  const fixture = await trackedTask()
  closeTask(fixture)

  const error = await refusal(() => pullOrTrack(fixture.deps, parseRef(ref)))

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({
    code: 'BAD_REQUEST',
    message: `${ref} is closed, so run \`monica task reopen ${ref}\``,
  })
})

test('pullToClose and pullToReopen refuse an untracked Task with NOT_FOUND, tracking nothing', async () => {
  const fixture = ledger()
  fixture.github.issue(ref, { title: 'Ship it' })

  for (const pull of [pullToClose, pullToReopen]) {
    const error = await refusal(() => pull(fixture.db, isIssue(parseRef(ref)), ref))
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: `${ref} is not tracked` })
  }
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('pullToClose refuses a closed Task with TaskStateRefusal as already closed', async () => {
  const fixture = await trackedTask()
  closeTask(fixture)

  const error = await refusal(() => pullToClose(fixture.db, isIssue(parseRef(ref)), ref))

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({ code: 'BAD_REQUEST', message: `${ref} is already closed` })
})

test('pullToReopen refuses an open Task with TaskStateRefusal', async () => {
  const fixture = await trackedTask()

  const error = await refusal(() => pullToReopen(fixture.db, isIssue(parseRef(ref)), ref))

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({ code: 'BAD_REQUEST', message: `${ref} is open` })
})

test('pullToClose pulls the Task inside a transaction', async () => {
  const fixture = await trackedTask()

  const found = fixture.db.transaction((tx) => pullToClose(tx, isIssue(parseRef(ref)), ref))

  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
})

test('refresh pulls the Task again by its row, so it carries the name a rename its sync copies', async () => {
  const fixture = await trackedTask()
  const before = pullOpen(fixture.db, isIssue(parseRef(ref)), ref)
  fixture.github.renameRepo('acme/app', 'acme/renamed')

  const { found, warnings } = await refresh(fixture.deps, before, pullOpen)

  expect(warnings).toEqual([])
  expect(found.issue).toMatchObject({ id: before.issue.id, repo: 'acme/renamed', number: 12 })
})

test('refresh goes on with the local copy when GitHub cannot be reached, and warns', async () => {
  const fixture = await trackedTask()
  const before = pullOpen(fixture.db, isIssue(parseRef(ref)), ref)
  fixture.github.logOut()

  const { found, warnings } = await refresh(fixture.deps, before, pullOpen)

  expect(warnings).toEqual([expect.stringContaining(`could not sync ${ref} from GitHub`)])
  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
  expect(
    fixture.db.select({ id: issue.id }).from(issue).where(eq(issue.number, 12)).all(),
  ).toHaveLength(1)
})
