import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runspace } from '@monica/workbench/schema'
import { eq } from 'drizzle-orm'

import { insertBench } from './bench.ts'
import {
  benchOf,
  hasBranch,
  ref,
  tabsOf,
  terminated,
  terminatedAfterClose,
  tracked,
  withWorktreeBench,
} from './close-fixture.ts'
import type { TaskChange } from './contract.ts'
import { commit, git } from './fake-ghq.ts'
import { issue } from './schema.ts'
import { cleanUp, failure } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

test('close takes down the Bench of a Task no guard stops: the worktree, the branch issue-n, the Runspace and its Tabs, whose Terminal Sessions it terminates', async () => {
  const fixture = await withWorktreeBench()
  const { db, client, ghq, cwd, taskLedger } = fixture
  const shell = await fixture.openTab(fixture.runspaceId)
  const changes: TaskChange[] = []
  taskLedger.events.subscribe('change', (change) => changes.push(change))

  const output = await client.close({ ref })

  expect(output).toEqual({
    ref,
    removedWorktree: cwd,
    deletedBranch: 'issue-12',
    spared: false,
    warnings: [],
  })
  const checkout = ghq.checkout('acme/app')
  expect(existsSync(cwd)).toBe(false)
  expect(hasBranch(checkout, 'issue-12')).toBe(false)
  expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain('issue-12')
  expect(db.select().from(runspace).all()).toEqual([])
  expect(tabsOf(fixture)).toEqual([])
  expect((await terminatedAfterClose(fixture, 2)).toSorted()).toEqual(
    [fixture.claudeTab, shell].toSorted(),
  )
  expect(await client.bench.list()).toEqual([])
  expect((await client.list({})).tasks).toEqual([])
  expect((await client.list({ closed: true })).tasks).toMatchObject([
    { ref, cwd: null, displayState: { state: 'closed' } },
  ])
  expect(changes).toContainEqual({ type: 'task', ref })
})

test('close called by the agent in a Tab of the Bench keeps that Tab and its claude in a Runspace it no longer owns, and the claude stays a Run of the closed Task', async () => {
  const fixture = await withWorktreeBench()
  const { db, client, claudeTab, runspaceId } = fixture
  const other = await fixture.openTab(runspaceId)
  await fixture.hook(claudeTab, 's-1', 'SessionStart', { source: 'startup' })

  const output = await client.close({ ref, terminalSessionId: claudeTab })

  expect(output).toMatchObject({ removedWorktree: fixture.cwd, spared: true })
  expect(db.select().from(runspace).all()).toMatchObject([{ id: runspaceId, owned: false }])
  expect(tabsOf(fixture)).toEqual([{ terminalSessionId: claudeTab }])
  expect(await terminatedAfterClose(fixture, 1)).toEqual([other])
  expect(await client.current({ terminalSessionId: claudeTab })).toMatchObject({
    ref,
    source: 'run',
    agentSessionId: 's-1',
    displayState: { state: 'closed' },
  })
})

test('close refuses with every reason it finds, a live Run, uncommitted changes and commits on no remote, and changes nothing; --force closes anyway', async () => {
  const fixture = await withWorktreeBench()
  const { client, cwd, ghq, claudeTab } = fixture
  await fixture.hook(claudeTab, 's-1', 'SessionStart', { source: 'startup' })
  commit(cwd, { 'wip.txt': { content: 'wip\n' } }, 'wip')
  writeFileSync(join(cwd, 'draft.txt'), 'draft\n')

  const error = await failure(client.close({ ref }))

  expect(error.code).toBe('CLOSE_REFUSED')
  expect(error.data).toEqual({
    reasons: [
      { kind: 'active_run', agentSessionId: 's-1', state: 'waiting' },
      { kind: 'uncommitted_changes', worktree: cwd },
      { kind: 'unpublished_commits', branch: 'issue-12' },
    ],
  })
  expect(error.message.split('\n')).toEqual([
    `${ref} stays open:`,
    'claude s-1 is a live Run (waiting)',
    `the worktree ${cwd} has uncommitted changes`,
    'branch issue-12 has commits on no remote',
    'pass --force to close anyway',
  ])
  expect(existsSync(join(cwd, 'draft.txt'))).toBe(true)
  expect(hasBranch(ghq.checkout('acme/app'), 'issue-12')).toBe(true)
  expect(benchOf(fixture)).toBeDefined()
  expect(tabsOf(fixture)).toEqual([{ terminalSessionId: claudeTab }])
  expect((await client.list({})).tasks).toMatchObject([{ ref }])
  expect(terminated(fixture)).toEqual([])

  expect(await client.close({ ref, force: true })).toMatchObject({
    removedWorktree: cwd,
    deletedBranch: 'issue-12',
  })
  expect(existsSync(cwd)).toBe(false)
  expect(hasBranch(ghq.checkout('acme/app'), 'issue-12')).toBe(false)
})

test('ignored files and commits pushed to a remote, merged or not, do not stop close', async () => {
  const fixture = await withWorktreeBench({ '.gitignore': { content: 'node_modules/\n' } })
  const { client, cwd } = fixture
  commit(cwd, { 'done.txt': { content: 'done\n' } }, 'done')
  git(cwd, 'push', '--quiet', 'origin', 'issue-12')
  mkdirSync(join(cwd, 'node_modules'))
  writeFileSync(join(cwd, 'node_modules/dep.js'), '')

  expect(await client.close({ ref })).toMatchObject({
    removedWorktree: cwd,
    deletedBranch: 'issue-12',
  })
})

test('commits on no remote stop close while the pull request of issue-n is open, and once it is squash merged close passes without --force and deletes the branch', async () => {
  const fixture = await withWorktreeBench()
  const { client, cwd, ghq, github } = fixture
  const head = commit(cwd, { 'done.txt': { content: 'done\n' } }, 'done')
  git(cwd, 'push', '--quiet', 'origin', 'issue-12')
  // squash merge は branch の commit を default branch に入れず、remote の branch も消す。
  git(cwd, 'push', '--quiet', 'origin', '--delete', 'issue-12')
  github.pullRequest('acme/app#30', { title: 'Ship it', headRef: 'issue-12', headOid: head })

  const refused = await failure(client.close({ ref }))
  github.pullRequest('acme/app#30', {
    title: 'Ship it',
    headRef: 'issue-12',
    headOid: head,
    state: 'merged',
  })
  const output = await client.close({ ref })

  expect(refused.data).toEqual({ reasons: [{ kind: 'unpublished_commits', branch: 'issue-12' }] })
  expect(output).toEqual({
    ref,
    removedWorktree: cwd,
    deletedBranch: 'issue-12',
    spared: false,
    warnings: [],
  })
  expect(hasBranch(ghq.checkout('acme/app'), 'issue-12')).toBe(false)
})

test('a merged pull request that only closes the Issue does not let close drop commits on no remote', async () => {
  const fixture = await withWorktreeBench()
  const { client, cwd, github } = fixture
  const head = commit(cwd, { 'done.txt': { content: 'done\n' } }, 'done')
  github.pullRequest('acme/app#30', {
    title: 'Ship it from elsewhere',
    headRef: 'elsewhere',
    headOid: head,
    state: 'merged',
  })
  github.issue(ref, { title: 'Ship it', closingPullRequests: ['acme/app#30'] })

  const error = await failure(client.close({ ref }))

  expect(error.data).toEqual({ reasons: [{ kind: 'unpublished_commits', branch: 'issue-12' }] })
})

test('commits put on issue-n after its pull request was merged still stop close', async () => {
  const fixture = await withWorktreeBench()
  const { client, cwd, github } = fixture
  const merged = commit(cwd, { 'done.txt': { content: 'done\n' } }, 'done')
  github.pullRequest('acme/app#30', {
    title: 'Ship it',
    headRef: 'issue-12',
    headOid: merged,
    state: 'merged',
  })
  commit(cwd, { 'more.txt': { content: 'more\n' } }, 'more')

  const error = await failure(client.close({ ref }))

  expect(error.data).toEqual({ reasons: [{ kind: 'unpublished_commits', branch: 'issue-12' }] })
})

test('a merged pull request whose head commit the checkout does not have does not let close drop commits on no remote', async () => {
  const fixture = await withWorktreeBench()
  const { client, cwd, github } = fixture
  commit(cwd, { 'done.txt': { content: 'done\n' } }, 'done')
  github.pullRequest('acme/app#30', { title: 'Ship it', headRef: 'issue-12', state: 'merged' })

  const error = await failure(client.close({ ref }))

  expect(error.data).toEqual({ reasons: [{ kind: 'unpublished_commits', branch: 'issue-12' }] })
})

test('close of an in-place Bench looks only at live Runs, and leaves the checkout and its branches alone', async () => {
  const fixture = await tracked({ origin: {} })
  const { client, ghq, db } = fixture
  await client.run({ ref, inPlace: true })
  const checkout = ghq.checkout('acme/app')
  git(checkout, 'switch', '--quiet', '-c', 'issue-12')
  commit(checkout, { 'wip.txt': { content: 'wip\n' } }, 'wip')
  writeFileSync(join(checkout, 'draft.txt'), 'draft\n')

  const output = await client.close({ ref })

  expect(output).toEqual({
    ref,
    removedWorktree: null,
    deletedBranch: null,
    spared: false,
    warnings: [],
  })
  expect(existsSync(join(checkout, 'draft.txt'))).toBe(true)
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
  expect(db.select().from(runspace).all()).toEqual([])
})

test('a live Run stops close of an in-place Bench', async () => {
  const fixture = await tracked()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const { terminalSessionId } = await fixture.client.run({ ref, inPlace: true })
  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  const error = await failure(fixture.client.close({ ref }))

  expect(error.data).toEqual({
    reasons: [{ kind: 'active_run', agentSessionId: 's-1', state: 'waiting' }],
  })
  expect(benchOf(fixture)).toBeDefined()
})

test('close of a Task without a Bench syncs it first, so list --closed shows the Issue as it was on GitHub', async () => {
  const fixture = await tracked()
  fixture.github.issue(ref, { title: 'Ship it now' })

  const output = await fixture.client.close({ ref })

  expect(output).toEqual({
    ref,
    removedWorktree: null,
    deletedBranch: null,
    spared: false,
    warnings: [],
  })
  expect((await fixture.client.list({ closed: true })).tasks).toMatchObject([
    { ref, title: 'Ship it now', displayState: { state: 'closed' } },
  ])
})

test('a claude that closed its Task stays its live Run, which stops another caller from closing the reopened Task without a Bench', async () => {
  const fixture = await withWorktreeBench()
  const { client, claudeTab } = fixture
  await fixture.hook(claudeTab, 's-1', 'SessionStart', { source: 'startup' })
  await client.close({ ref, terminalSessionId: claudeTab })
  await client.reopen({ ref })

  const error = await failure(client.close({ ref }))

  expect(error.data).toEqual({
    reasons: [{ kind: 'active_run', agentSessionId: 's-1', state: 'waiting' }],
  })
  expect(await client.close({ ref, terminalSessionId: claudeTab })).toMatchObject({
    removedWorktree: null,
    spared: false,
  })
})

test('close goes on with the local copy when GitHub cannot be reached, and warns', async () => {
  const fixture = await tracked()
  fixture.github.logOut()

  const output = await fixture.client.close({ ref })

  expect(output.warnings).toEqual([
    expect.stringContaining(`could not sync ${ref} from GitHub (\`gh auth token\` failed`),
  ])
  expect((await fixture.client.list({ closed: true })).tasks).toMatchObject([{ ref }])
})

test('when git fails, close stops, and the Task, its Bench and its Tabs stay as they were', async () => {
  const fixture = await withWorktreeBench()
  const { db, client, ghq, cwd, claudeTab } = fixture
  git(ghq.checkout('acme/app'), 'worktree', 'lock', cwd)

  const error = await failure(client.close({ ref }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain('git worktree remove failed')
  expect(existsSync(cwd)).toBe(true)
  expect(benchOf(fixture)).toBeDefined()
  expect(db.select().from(runspace).all()).toMatchObject([{ owned: true }])
  expect(tabsOf(fixture)).toEqual([{ terminalSessionId: claudeTab }])
  expect((await client.list({})).tasks).toMatchObject([{ ref }])
  expect(terminated(fixture)).toEqual([])
})

test('close drops the registration of a worktree that is gone, and still deletes the branch issue-n', async () => {
  const fixture = await withWorktreeBench()
  const { client, ghq, cwd } = fixture
  rmSync(cwd, { recursive: true, force: true })

  const output = await client.close({ ref })

  expect(output).toMatchObject({ removedWorktree: null, deletedBranch: 'issue-12' })
  const checkout = ghq.checkout('acme/app')
  expect(hasBranch(checkout, 'issue-12')).toBe(false)
  expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain('issue-12')
})

test('a worktree Bench whose worktree and branch issue-n are both gone has nothing to stop close or to remove', async () => {
  const fixture = await withWorktreeBench()
  const checkout = fixture.ghq.checkout('acme/app')
  git(checkout, 'worktree', 'remove', '--force', fixture.cwd)
  git(checkout, 'branch', '-D', 'issue-12')

  const output = await fixture.client.close({ ref })

  expect(output).toMatchObject({ removedWorktree: null, deletedBranch: null })
  expect(benchOf(fixture)).toBeUndefined()
})

test("close leaves the worktree and the branch alone when another Task's Bench has the same path", async () => {
  const fixture = await withWorktreeBench()
  const { db, workbenchLedger, client, github, ghq, cwd } = fixture
  // 改名した repo の旧名を別の repo が使い、その Task が同じ path に Bench を開いた形を、行で作る。
  github.issue('acme/app#13', { title: 'Next' })
  await client.track({ ref: 'acme/app#13' })
  const other = db.select().from(issue).where(eq(issue.number, 13)).get()!
  db.transaction((tx) =>
    insertBench(tx, workbenchLedger, other, { cwd, mode: 'worktree', setupState: 'ready' }),
  )

  const output = await client.close({ ref })

  expect(output).toMatchObject({ removedWorktree: null, deletedBranch: null })
  expect(existsSync(cwd)).toBe(true)
  expect(hasBranch(ghq.checkout('acme/app'), 'issue-12')).toBe(true)
  expect(await client.bench.list()).toMatchObject([{ ref: 'acme/app#13' }])
})

test('close removes the worktree through the checkout it was made in, even after the repo is renamed', async () => {
  const fixture = await withWorktreeBench()
  const { client, ghq, cwd, github } = fixture
  github.renameRepo('acme/app', 'acme/renamed')

  const output = await client.close({ ref })

  expect(output).toMatchObject({
    ref: 'acme/renamed#12',
    removedWorktree: cwd,
    deletedBranch: 'issue-12',
  })
  expect(hasBranch(ghq.checkout('acme/app'), 'issue-12')).toBe(false)
})

test('close refuses a Task that is already closed or not tracked', async () => {
  const fixture = await tracked()
  await fixture.client.close({ ref })

  expect((await failure(fixture.client.close({ ref }))).code).toBe('BAD_REQUEST')
  expect((await failure(fixture.client.close({ ref: 'acme/app#99' }))).code).toBe('NOT_FOUND')
})

test('close refuses a Bench that is still being prepared, even with --force', async () => {
  const fixture = await tracked()
  const { client, ghq } = fixture
  const asked = Promise.withResolvers<void>()
  const cloned = Promise.withResolvers<void>()
  spyOn(ghq.client, 'get').mockImplementation(() => {
    asked.resolve()
    return cloned.promise
  })
  const running = client.run({ ref, inPlace: true })
  await asked.promise

  const error = await failure(client.close({ ref, force: true }))
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  cloned.resolve()
  await running

  expect(error.code).toBe('CONFLICT')
  expect(error.message).toContain('being prepared')
  expect(benchOf(fixture)).toMatchObject({ setupState: 'ready' })
  expect((await client.list({})).tasks).toMatchObject([{ ref }])
})

test('reopen opens a closed Task with no Bench, not started', async () => {
  const { client, taskLedger } = await tracked()
  await client.close({ ref })
  const changes: TaskChange[] = []
  taskLedger.events.subscribe('change', (change) => changes.push(change))

  const output = await client.reopen({ ref })

  expect(output).toEqual({ ref, title: 'Ship it', warnings: [] })
  expect(changes).toContainEqual({ type: 'task', ref })
  expect((await client.list({})).tasks).toMatchObject([
    { ref, cwd: null, displayState: { state: 'not_started' } },
  ])
})

test('reopen syncs the Task, so one whose Issue was closed on GitHub meanwhile shows issue_closed', async () => {
  const fixture = await tracked()
  await fixture.client.close({ ref })
  fixture.github.issue(ref, { title: 'Ship it', state: 'closed' })

  await fixture.client.reopen({ ref })

  expect((await fixture.client.list({})).tasks).toMatchObject([
    { ref, issueState: 'closed', displayState: { state: 'issue_closed' } },
  ])
})

test('reopen goes on with the local copy when GitHub cannot be reached, and warns', async () => {
  const fixture = await tracked()
  await fixture.client.close({ ref })
  fixture.github.logOut()

  const output = await fixture.client.reopen({ ref })

  expect(output.warnings).toEqual([expect.stringContaining(`could not sync ${ref} from GitHub`)])
  expect((await fixture.client.list({})).tasks).toMatchObject([{ ref }])
})

test('reopen refuses a Task that is open or not tracked', async () => {
  const fixture = await tracked()

  expect((await failure(fixture.client.reopen({ ref }))).code).toBe('BAD_REQUEST')
  expect((await failure(fixture.client.reopen({ ref: 'acme/app#99' }))).code).toBe('NOT_FOUND')
})

test("reopen asked by a repo's old name follows the rename its sync finds", async () => {
  const fixture = await tracked()
  await fixture.client.close({ ref })
  fixture.github.renameRepo('acme/app', 'acme/renamed')

  expect(await fixture.client.reopen({ ref })).toMatchObject({ ref: 'acme/renamed#12' })
  expect(
    fixture.db.select({ repo: issue.repo }).from(issue).where(eq(issue.number, 12)).get(),
  ).toEqual({ repo: 'acme/renamed' })
})
