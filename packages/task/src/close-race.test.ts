import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runspace } from '@monica/workbench/schema'

import {
  benchOf,
  type Fixture,
  ref,
  tabsOf,
  terminatedAfterClose,
  tracked,
  until,
  withWorktreeBench,
} from './close-fixture.ts'
import { SYNC_BEFORE_COMMAND_TIMEOUT_MS } from './sync.ts'
import { cleanUp, failure } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

// close は GitHub を待つ間も Task を押さえているので、hold した sync の間に呼べば競合を決まった順で起こせる。
async function closeHeldAtSync(fixture: Fixture) {
  const sent = fixture.github.requests.length
  const release = fixture.github.hold()
  const closing = fixture.client.close({ ref })
  await fixture.github.received(sent + 1)
  return { closing, release }
}

test('while close is under way, a new run and attach on its Task are refused, so nothing enters the Bench it takes down', async () => {
  const fixture = await withWorktreeBench()
  const { client } = fixture
  const outside = await fixture.openTabOutsideBench()
  const { closing, release } = await closeHeldAtSync(fixture)

  const attached = await failure(client.attach({ ref, terminalSessionId: outside }))
  const running = failure(client.run({ ref }))
  release()

  expect(attached.code).toBe('CONFLICT')
  expect((await running).code).toBe('CONFLICT')
  expect(await closing).toMatchObject({ removedWorktree: fixture.cwd })
  expect(fixture.db.select({ owned: runspace.owned }).from(runspace).all()).toEqual([
    { owned: false },
  ])
  expect(tabsOf(fixture)).toEqual([{ terminalSessionId: outside }])
})

test('while close is under way, a run that would resume the last claude is refused', async () => {
  const fixture = await withWorktreeBench()
  await fixture.hook(fixture.claudeTab, 's-1', 'SessionStart', { source: 'startup' })
  await fixture.hook(fixture.claudeTab, 's-1', 'SessionEnd', { reason: 'exit' })
  const { closing, release } = await closeHeldAtSync(fixture)

  const error = await failure(fixture.client.run({ ref }))
  release()

  expect(error.code).toBe('CONFLICT')
  expect(await closing).toMatchObject({ removedWorktree: fixture.cwd })
  expect(fixture.ptyd.receivedAll((op) => op.op === 'create')).toHaveLength(1)
})

test('a run --in-place that waited on ghq while the Task was closed opens no Bench', async () => {
  const fixture = await tracked()
  const { client, db, ghq } = fixture
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  const root = await ghq.client.root()
  spyOn(ghq.client, 'root').mockImplementation(() => {
    asked.resolve()
    return answer.promise
  })
  const running = failure(client.run({ ref, inPlace: true }))
  await asked.promise

  await client.close({ ref })
  answer.resolve(root)

  expect((await running).code).toBe('BAD_REQUEST')
  expect(benchOf(fixture)).toBeUndefined()
  expect(db.select().from(runspace).all()).toEqual([])
})

test('a second close while the first is under way is refused', async () => {
  const fixture = await withWorktreeBench()
  const { closing, release } = await closeHeldAtSync(fixture)

  const error = await failure(fixture.client.close({ ref }))
  release()

  expect(error.code).toBe('CONFLICT')
  expect(await closing).toMatchObject({ removedWorktree: fixture.cwd })
})

// git の reference-transaction hook で、close の `branch -D issue-12` を release の file ができるまで止める。
function pauseBranchDeletion(fixture: Fixture) {
  const marks = join(fixture.home, 'pause')
  mkdirSync(marks)
  const started = join(marks, 'started')
  const release = join(marks, 'release')
  const hook = join(fixture.ghq.checkout('acme/app'), '.git/hooks/reference-transaction')
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      '[ "$1" = prepared ] || exit 0',
      'grep -q refs/heads/issue-12 || exit 0',
      `touch '${started}'`,
      `while [ ! -e '${release}' ]; do sleep 0.02; done`,
    ].join('\n'),
  )
  chmodSync(hook, 0o755)
  return { started, release }
}

test("a claude that becomes a Run while close removes the worktree keeps its Tab, like the caller's, and close completes", async () => {
  const fixture = await withWorktreeBench()
  const { db, client, claudeTab, runspaceId } = fixture
  const other = await fixture.openTab(runspaceId)
  const pause = pauseBranchDeletion(fixture)
  const closing = client.close({ ref })
  await until(() => existsSync(pause.started))

  await fixture.hook(claudeTab, 's-1', 'SessionStart', { source: 'startup' })
  writeFileSync(pause.release, '')
  const output = await closing

  expect(output).toEqual({
    ref,
    removedWorktree: fixture.cwd,
    deletedBranch: 'issue-12',
    spared: false,
    warnings: ['claude s-1 started in the Bench while closing, so its Tab stays'],
  })
  expect(db.select().from(runspace).all()).toMatchObject([{ id: runspaceId, owned: false }])
  expect(tabsOf(fixture)).toEqual([{ terminalSessionId: claudeTab }])
  expect(await terminatedAfterClose(fixture, 1)).toEqual([other])
  expect((await client.list({ closed: true })).tasks).toMatchObject([{ ref }])
})

test('close returns before ptyd answers the Terminate of the Bench, and the Task reopens right after', async () => {
  const fixture = await withWorktreeBench()
  const finish = fixture.ptyd.holdNext('terminate')

  await fixture.client.close({ ref })
  const output = await fixture.client.reopen({ ref })
  finish()

  expect(output).toMatchObject({ ref })
  expect(await terminatedAfterClose(fixture, 1)).toEqual([fixture.claudeTab])
})

// 止めた sync に後から来た同じ Task の sync は、合流して自分の timeout まで待つ。その timeout を手で起こし、写しで進ませる。
function catchJoinedSyncTimeouts() {
  const realSetTimeout = globalThis.setTimeout
  const caught: PromiseWithResolvers<() => void>[] = []
  const nth = (n: number) => (caught[n] ??= Promise.withResolvers())
  let count = 0
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== SYNC_BEFORE_COMMAND_TIMEOUT_MS) return realSetTimeout(callback, ms)
    nth(count++).resolve(callback)
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout)
  return async (n: number) => (await nth(n).promise)()
}

test('a reopen that reaches its transaction while close is under way is refused, so close returns its Task closed', async () => {
  const fixture = await tracked({ origin: {} })
  const { client, github } = fixture
  await client.close({ ref })
  const sent = github.requests.length
  const releaseSync = github.hold()
  const late = failure(client.reopen({ ref }))
  await github.received(sent + 1)
  const giveUpJoinedSync = catchJoinedSyncTimeouts()
  const reopened = client.reopen({ ref })
  await giveUpJoinedSync(0)
  await reopened
  const running = client.run({ ref })
  await giveUpJoinedSync(1)
  await running
  const pause = pauseBranchDeletion(fixture)
  const closing = client.close({ ref })
  await giveUpJoinedSync(2)
  await until(() => existsSync(pause.started))

  releaseSync()
  const error = await late
  writeFileSync(pause.release, '')

  expect(error.code).toBe('CONFLICT')
  expect(error.message).toBe(`${ref} is being closed`)
  expect(await closing).toMatchObject({ ref, removedWorktree: fixture.cwd })
  expect((await client.list({ closed: true })).tasks).toMatchObject([{ ref }])
})
