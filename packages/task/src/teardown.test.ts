import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commit, fakeGhq, git, stackedThenRebased } from './fake-ghq.ts'
import { inspectWorktree, removeWorktree } from './teardown.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const forIssue = { repo: 'acme/app', number: 12 }

function worktreeOnIssue12() {
  const scratch = mkdtempSync(join(tmpdir(), 'monica-teardown-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  const ghq = fakeGhq(scratch)
  ghq.origin('acme/app')
  ghq.clone('acme/app')
  const checkout = ghq.checkout('acme/app')
  const path = join(scratch, 'worktree')
  git(checkout, 'worktree', 'add', '--quiet', '-b', 'issue-12', path, 'origin/main')
  return { ghq, checkout, path }
}

async function inspectedClean({ squashMerged = false } = {}) {
  const { ghq, checkout, path } = worktreeOnIssue12()
  // squash merge した PR の head は、remote のどこからも辿れない commit になる。
  const mergedHeads = squashMerged
    ? [commit(path, { 'done.txt': { content: 'done\n' } }, 'done')]
    : []
  const inspected = await inspectWorktree(
    ghq.client,
    { cwd: path, branch: 'issue-12' },
    forIssue,
    mergedHeads,
  )
  expect(inspected.refusals).toEqual([])
  return { checkout, path, inspected }
}

function hasBranch(checkout: string, branch: string): boolean {
  return Bun.spawnSync(
    ['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { env: process.env },
  ).success
}

test('without force, changes written to the worktree after it was inspected stop the removal, and the files stay', async () => {
  const { checkout, path, inspected } = await inspectedClean()
  writeFileSync(join(path, 'late.txt'), 'late\n')

  await expect(removeWorktree(inspected, { force: false })).rejects.toThrow(
    'git worktree remove failed',
  )

  expect(existsSync(join(path, 'late.txt'))).toBe(true)
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})

test('without force, commits on no remote made after the inspection keep the branch, with a warning', async () => {
  const { checkout, inspected, path } = await inspectedClean()
  commit(path, { 'late.txt': { content: 'late\n' } }, 'late')

  expect(await removeWorktree(inspected, { force: false })).toEqual({
    removedWorktree: path,
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(existsSync(path)).toBe(false)
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})

test('without force, commits made after the inspection on top of the head of a merged pull request keep the branch', async () => {
  const { checkout, inspected, path } = await inspectedClean({ squashMerged: true })
  commit(path, { 'late.txt': { content: 'late\n' } }, 'late')

  expect(await removeWorktree(inspected, { force: false })).toMatchObject({
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})

function rebasedBench(options: Parameters<typeof stackedThenRebased>[2]) {
  const { ghq, checkout, path } = worktreeOnIssue12()
  const mergedHeads = [stackedThenRebased(path, checkout, options)]
  const inspect = () =>
    inspectWorktree(ghq.client, { cwd: path, branch: 'issue-12' }, forIssue, mergedHeads)
  return { checkout, path, inspect }
}

test.each([false, true])(
  'commits whose patches the rebased head of a merged pull request has do not stop the removal, and the branch goes (main moved on before the rebase: %p)',
  async (mainMovedOn) => {
    const { checkout, path, inspect } = rebasedBench({ mainMovedOn })

    const inspected = await inspect()

    expect(inspected.refusals).toEqual([])
    expect(await removeWorktree(inspected, { force: false })).toEqual({
      removedWorktree: path,
      deletedBranch: 'issue-12',
      warnings: [],
    })
    expect(hasBranch(checkout, 'issue-12')).toBe(false)
  },
)

test('a commit whose patch no merged head has still stops the removal of a rebased branch', async () => {
  const { path, inspect } = rebasedBench({ mainMovedOn: true })
  commit(path, { 'c.txt': { content: 'c\n' } }, 'c1')

  expect((await inspect()).refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

test('a commit under the rebased ones whose patch the squash of its pull request does not match still stops the removal', async () => {
  const { inspect } = rebasedBench({
    mainMovedOn: false,
    squashOfA: { 'a.txt': { content: 'a\n' }, 'a2.txt': { content: 'a2\n' } },
  })

  expect((await inspect()).refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

test('a commit whose patch differs from the squash of its pull request only in whitespace still stops the removal', async () => {
  const { inspect } = rebasedBench({
    mainMovedOn: false,
    squashOfA: { 'a.txt': { content: 'a \n' } },
  })

  expect((await inspect()).refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

test('without force, a commit whose patch no merged head has, made after the inspection on a rebased branch, keeps the branch', async () => {
  const { checkout, path, inspect } = rebasedBench({ mainMovedOn: true })
  const inspected = await inspect()
  commit(path, { 'c.txt': { content: 'c\n' } }, 'c1')

  expect(await removeWorktree(inspected, { force: false })).toMatchObject({
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})
