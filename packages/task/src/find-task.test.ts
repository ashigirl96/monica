import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { isIssue } from './copy.ts'
import { findOrTrack, findTask, refreshTask } from './find-task.ts'
import { TaskStateRefusal } from './open-task.ts'
import { parseRef } from './ref.ts'
import { issue, task } from './schema.ts'
import { internals } from './task.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(cleanUp)

function thrown(find: () => unknown) {
  return failure(Promise.resolve().then(find))
}

const ref = 'acme/app#12'

function untracked() {
  const fixture = setup()
  return { ...fixture, deps: internals(fixture.taskLedger) }
}

async function trackedTask() {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  return { ...fixture, deps: internals(fixture.taskLedger) }
}

function close({ db }: ReturnType<typeof setup>) {
  db.update(task).set({ closedAt: new Date() }).run()
}

test('findOrTrack tracks an untracked ref and finds the Task by the name GitHub has now, even when asked by the old name', async () => {
  const { github, deps } = untracked()
  github.issue(ref, { title: 'Ship it' })
  github.renameRepo('acme/app', 'acme/renamed')

  const { found, tracked } = await findOrTrack(deps, parseRef(ref))

  expect(tracked).toBe(true)
  expect(found.issue).toMatchObject({ repo: 'acme/renamed', number: 12, title: 'Ship it' })
  expect(found.task.closedAt).toBeNull()
})

test('findOrTrack finds a tracked Task without tracking it again', async () => {
  const { deps } = await trackedTask()

  const { found, tracked: trackedNow } = await findOrTrack(deps, parseRef(ref))

  expect(trackedNow).toBe(false)
  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
})

test('findOrTrack finds a tracked Task by node ID, even when its name is asked under a repo GitHub renamed', async () => {
  const { db, github, deps } = await trackedTask()
  const { nodeId } = db.select({ nodeId: issue.nodeId }).from(issue).get()!
  github.renameRepo('acme/app', 'acme/renamed')

  const { found } = await findOrTrack(deps, parseRef('acme/renamed#12'), nodeId!)

  expect(found.issue).toMatchObject({ repo: 'acme/app', number: 12 })
})

test('findOrTrack refuses a ref GitHub does not return with NOT_FOUND, and writes neither a Task nor a copy', async () => {
  const { db, deps } = untracked()

  const error = await failure(findOrTrack(deps, parseRef('acme/app#99')))

  expect(error.code).toBe('NOT_FOUND')
  expect(db.select().from(task).all()).toEqual([])
  expect(db.select().from(issue).all()).toEqual([])
})

test('findOrTrack refuses a closed Task with TaskStateRefusal, pointing to reopen', async () => {
  const fixture = await trackedTask()
  close(fixture)

  const error = await failure(findOrTrack(fixture.deps, parseRef(ref)))

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({
    code: 'BAD_REQUEST',
    message: `${ref} is closed, so run \`monica task reopen ${ref}\``,
  })
})

test('findTask refuses an untracked ref with NOT_FOUND, without asking GitHub', async () => {
  const { db, github } = untracked()
  github.issue(ref, { title: 'Ship it' })

  for (const entry of ['run', 'close', 'reopen'] as const) {
    const error = await thrown(() => findTask(db, isIssue(parseRef(ref)), ref, entry))
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: `${ref} is not tracked` })
  }
  expect(github.requests).toEqual([])
})

test('findTask for close refuses a closed Task with TaskStateRefusal, saying it is already closed', async () => {
  const fixture = await trackedTask()
  close(fixture)

  const error = await thrown(() => findTask(fixture.db, isIssue(parseRef(ref)), ref, 'close'))

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({ code: 'BAD_REQUEST', message: `${ref} is already closed` })
})

test('findTask for reopen refuses an open Task with TaskStateRefusal, and finds a closed one', async () => {
  const fixture = await trackedTask()

  const error = await thrown(() => findTask(fixture.db, isIssue(parseRef(ref)), ref, 'reopen'))
  close(fixture)

  expect(error).toBeInstanceOf(TaskStateRefusal)
  expect(error).toMatchObject({ code: 'BAD_REQUEST', message: `${ref} is open` })
  expect(findTask(fixture.db, isIssue(parseRef(ref)), ref, 'reopen').issue).toMatchObject({
    repo: 'acme/app',
    number: 12,
  })
})

test('refreshTask finds the Task again by its row, so it has the name the sync copied from a renamed repo', async () => {
  const { db, github, deps } = await trackedTask()
  const found = findTask(db, isIssue(parseRef(ref)), ref, 'run')
  github.renameRepo('acme/app', 'acme/renamed')

  const refreshed = await refreshTask(deps, found, 'run')

  expect(refreshed.warnings).toEqual([])
  expect(refreshed.found.issue).toMatchObject({ id: found.issue.id, repo: 'acme/renamed' })
})

test('refreshTask goes on with the local copy when GitHub cannot be reached, and warns', async () => {
  const { db, github, deps } = await trackedTask()
  const found = findTask(db, isIssue(parseRef(ref)), ref, 'run')
  github.logOut()

  const refreshed = await refreshTask(deps, found, 'run')

  expect(refreshed.warnings).toEqual([
    expect.stringContaining(`could not sync ${ref} from GitHub (\`gh auth token\` failed`),
  ])
  expect(refreshed.found.issue).toMatchObject({ id: found.issue.id, repo: 'acme/app' })
})

test('refreshTask refuses the Task found again in a state its entry does not take', async () => {
  const fixture = await trackedTask()
  const found = findTask(fixture.db, eq(issue.number, 12), ref, 'run')
  close(fixture)

  const error = await failure(refreshTask(fixture.deps, found, 'run'))

  expect(error).toBeInstanceOf(TaskStateRefusal)
})
