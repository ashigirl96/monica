import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { writeFakeExecutable } from '@monica/workbench/testing'

import { commit, fakeGhq, type Files, git, stackedThenRebased } from './fake-ghq.ts'
import { type InspectedWorktree, inspectWorktree, removeWorktree } from './teardown.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const forIssue = { repo: 'acme/app', number: 12 }

function worktreeOnIssue12(files: Files = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'monica-teardown-'))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  const ghq = fakeGhq(scratch)
  ghq.origin('acme/app', files)
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

const trashBeside = ({ path }: { path: string }) => join(dirname(path), 'trash')

const removeBeside = (inspected: InspectedWorktree) =>
  removeWorktree(inspected, { force: false, trash: trashBeside(inspected) })

test('without force, changes written to the worktree after it was inspected stop the removal, and the files stay', async () => {
  const { checkout, path, inspected } = await inspectedClean()
  writeFileSync(join(path, 'late.txt'), 'late\n')

  await expect(removeBeside(inspected)).rejects.toThrow(
    `the worktree ${path} got changes after it was inspected`,
  )

  expect(existsSync(join(path, 'late.txt'))).toBe(true)
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
  expect(readdirSync(trashBeside(inspected))).toEqual([])
})

test('without force, a git that fails in the trash stops the removal, and the worktree goes back to its path', async () => {
  const { checkout, path, inspected } = await inspectedClean()
  // 相対の gitdir は元の path からしか辿れないので、捨て場でだけ git が動かない。
  const gitdir = git(path, 'rev-parse', '--absolute-git-dir')
  writeFileSync(join(path, '.git'), `gitdir: ${relative(realpathSync(path), gitdir)}\n`)

  await expect(removeBeside(inspected)).rejects.toThrow('git status --porcelain failed')

  expect(git(path, 'status', '--porcelain')).toBe('')
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
  expect(readdirSync(trashBeside(inspected))).toEqual([])
})

test('without force, commits made in the trash before the registration is dropped keep the branch, with a warning', async () => {
  const { checkout, inspected, path } = await inspectedClean()
  // 捨て場で取り直す git status が fsmonitor の hook を呼ぶので、その中で issue-12 に commit を積む。
  const hook = join(dirname(path), 'commit-once')
  const once = join(dirname(path), 'committed')
  writeFakeExecutable(
    hook,
    `[ -e '${once}' ] && exit 1\ntouch '${once}'\ngit update-ref refs/heads/issue-12 "$(git -c user.name=monica -c user.email=monica@example.com commit-tree 'HEAD^{tree}' -p HEAD -m late)"\nexit 1`,
  )
  git(checkout, 'config', 'core.fsmonitor', hook)

  expect(await removeBeside(inspected)).toEqual({
    removedWorktree: path,
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(existsSync(once)).toBe(true)
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})

test('without force, commits on no remote made after the inspection keep the branch, with a warning', async () => {
  const { checkout, inspected, path } = await inspectedClean()
  commit(path, { 'late.txt': { content: 'late\n' } }, 'late')

  expect(await removeBeside(inspected)).toEqual({
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

  expect(await removeBeside(inspected)).toMatchObject({
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})

test('the removal drops only the registration of its own missing worktree, leaving another missing worktree registered', async () => {
  const { ghq, checkout, path } = worktreeOnIssue12()
  const another = join(realpathSync(dirname(path)), 'another')
  git(checkout, 'worktree', 'add', '--quiet', '-b', 'another', another, 'origin/main')
  rmSync(another, { recursive: true, force: true })
  rmSync(path, { recursive: true, force: true })

  const inspected = await inspectWorktree(
    ghq.client,
    { cwd: path, branch: 'issue-12' },
    forIssue,
    [],
  )
  await removeBeside(inspected)

  const registered = git(checkout, 'worktree', 'list', '--porcelain')
  expect(registered).toContain(`worktree ${another}\n`)
  expect(registered).not.toContain('refs/heads/issue-12')
  expect(hasBranch(checkout, 'issue-12')).toBe(false)
})

function rebasedBench(options: Parameters<typeof stackedThenRebased>[2]) {
  const { ghq, checkout, path } = worktreeOnIssue12()
  const mergedHeads = [stackedThenRebased(path, checkout, options)]
  const inspect = () =>
    inspectWorktree(ghq.client, { cwd: path, branch: 'issue-12' }, forIssue, mergedHeads)
  return { checkout, path, inspect }
}

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

test('a commit whose patch differs from the squash of its pull request only in bytes that are not UTF-8 still stops the removal', async () => {
  const { inspect } = rebasedBench({
    mainMovedOn: false,
    a: { 'a.txt': { content: Uint8Array.of(0x80, 0x0a) } },
    squashOfA: { 'a.txt': { content: Uint8Array.of(0x81, 0x0a) } },
  })

  expect((await inspect()).refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

function addThenRevert(repo: string) {
  commit(repo, { 'a.txt': { content: 'a\n' } }, 'add a')
  git(repo, 'rm', '--quiet', 'a.txt')
  return commit(repo, {}, 'revert a')
}

test('a patch put back on the branch after a revert stops the removal, though the merged head has the patch and the revert once', async () => {
  const { ghq, checkout, path } = worktreeOnIssue12()
  addThenRevert(path)
  commit(path, { 'a.txt': { content: 'a\n' } }, 'add a again')
  git(checkout, 'switch', '--quiet', '--detach', 'origin/main')
  const mergedHead = addThenRevert(checkout)
  git(checkout, 'switch', '--quiet', '-')

  const inspected = await inspectWorktree(ghq.client, { cwd: path, branch: 'issue-12' }, forIssue, [
    mergedHead,
  ])

  expect(inspected.refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

test('a change to one of two blocks with the same context stops the removal, though the merged head changed the other block with the same patch', async () => {
  const block = 'a\nb\nc\nfoo\nd\ne\nf\n'
  const { ghq, checkout, path } = worktreeOnIssue12({ 'twice.txt': { content: block + block } })
  const changed = block.replace('foo', 'FOO')
  commit(path, { 'twice.txt': { content: changed + block } }, 'change the first foo')
  git(checkout, 'switch', '--quiet', '--detach', 'origin/main')
  const mergedHead = commit(
    checkout,
    { 'twice.txt': { content: block + changed } },
    'change the second foo',
  )
  git(checkout, 'switch', '--quiet', '-')

  const inspected = await inspectWorktree(ghq.client, { cwd: path, branch: 'issue-12' }, forIssue, [
    mergedHead,
  ])

  expect(inspected.refusals).toEqual([{ kind: 'unpublished_commits', branch: 'issue-12' }])
})

test('without force, a commit whose patch no merged head has, made after the inspection on a rebased branch, keeps the branch', async () => {
  const { checkout, path, inspect } = rebasedBench({ mainMovedOn: true })
  const inspected = await inspect()
  commit(path, { 'c.txt': { content: 'c\n' } }, 'c1')

  expect(await removeBeside(inspected)).toMatchObject({
    deletedBranch: null,
    warnings: ['branch issue-12 got commits on no remote while closing, so it stays'],
  })
  expect(hasBranch(checkout, 'issue-12')).toBe(true)
})
