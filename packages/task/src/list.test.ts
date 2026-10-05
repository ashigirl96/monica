import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { issue, task } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

type Fixture = ReturnType<typeof setup>

function close({ db }: Fixture, number: number) {
  const { id } = db.select().from(issue).where(eq(issue.number, number)).get()!
  db.update(task).set({ closedAt: new Date() }).where(eq(task.issueId, id)).run()
}

test('list shows open Tasks in tracked order with their open Blockers and display state', async () => {
  const fixture = setup()
  const { github, client } = fixture
  github.issue('acme/app#4', { title: 'Schema first' })
  github.issue('acme/lib#3', { title: 'Upstream fix' })
  github.issue('acme/app#5', { title: 'Done already', state: 'closed' })
  github.issue('acme/app#12', {
    title: 'Ship it',
    blockedBy: ['acme/app#4', 'acme/lib#3', 'acme/app#5'],
  })
  github.issue('acme/app#2', { title: 'Merged, not cleaned up', state: 'closed' })
  github.issue('acme/app#1', { title: 'Shipped' })
  for (const ref of ['acme/app#12', 'acme/app#2', 'acme/app#1']) await client.track({ ref })
  close(fixture, 1)

  const output = await client.list({})

  expect(output).toEqual({
    tasks: [
      {
        ref: 'acme/app#12',
        title: 'Ship it',
        issueState: 'open',
        blockers: ['acme/app#4', 'acme/lib#3'],
        cwd: null,
        displayState: { state: 'not_started' },
      },
      {
        ref: 'acme/app#2',
        title: 'Merged, not cleaned up',
        issueState: 'closed',
        blockers: [],
        cwd: null,
        displayState: { state: 'issue_closed' },
      },
    ],
    backgroundSyncError: null,
  })
})

test('list with closed shows only the closed Tasks', async () => {
  const fixture = setup()
  const { github, client } = fixture
  github.issue('acme/app#1', { title: 'Shipped' })
  github.issue('acme/app#2', { title: 'Open' })
  for (const ref of ['acme/app#1', 'acme/app#2']) await client.track({ ref })
  close(fixture, 1)

  const output = await client.list({ closed: true })

  expect(output.tasks.map((t) => [t.ref, t.displayState.state])).toEqual([['acme/app#1', 'closed']])
})

test('syncInBackground copies the Issues of the open Tasks from GitHub', async () => {
  const { github, client, taskLedger } = setup()
  github.issue('acme/app#1', { title: 'One' })
  await client.track({ ref: 'acme/app#1' })
  github.issue('acme/app#1', { title: 'One, renamed' })
  github.requests.length = 0

  await taskLedger.syncInBackground()
  const output = await client.list({})

  expect(github.requests).toEqual([{ repo: 'acme/app', numbers: [1], branches: [] }])
  expect(output.tasks[0]?.title).toBe('One, renamed')
  expect(output.backgroundSyncError).toBeNull()
})

test('a failed background sync rejects and shows in list until one succeeds', async () => {
  const { github, client, taskLedger } = setup()
  github.issue('acme/app#1', { title: 'One' })
  await client.track({ ref: 'acme/app#1' })
  github.logOut()

  const rejected = await taskLedger.syncInBackground().catch((error: unknown) => error)
  const failed = await client.list({})
  github.logIn()
  await taskLedger.syncInBackground()
  const recovered = await client.list({})

  expect(rejected).toBeInstanceOf(Error)
  expect((rejected as Error).message).toContain('gh auth token')
  expect(failed.backgroundSyncError).toEqual({
    at: expect.any(Date),
    message: expect.stringContaining('gh auth token'),
  })
  expect(recovered.backgroundSyncError).toBeNull()
  expect(recovered.tasks).toHaveLength(1)
})

test('start neither syncs nor sets a timer; the Job Ledger runs the background sync', async () => {
  const setInterval = spyOn(globalThis, 'setInterval')
  const { github, client, taskLedger } = setup()
  github.issue('acme/app#1', { title: 'One' })
  await client.track({ ref: 'acme/app#1' })
  github.requests.length = 0

  taskLedger.start()
  await Bun.sleep(20)

  expect(github.requests).toEqual([])
  expect(setInterval).not.toHaveBeenCalled()
})
