import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Bench } from './bench.ts'
import type { CloseRefusal } from './contract.ts'
import { branchOf, checkoutOf, type Ghq, git, gitPiped, succeeds } from './prepare.ts'
import type { IssueRef } from './ref.ts'

export type InspectedWorktree = {
  path: string
  branch: string
  /** null なら checkout が無く、消すものも無い。 */
  checkout: string | null
  present: boolean
  branchExists: boolean
  mergedHeads: string[]
  refusals: CloseRefusal[]
}

/** 失敗は 1 行の理由を message に持つ Error で投げる。 */
export async function inspectWorktree(
  ghq: Ghq,
  row: Pick<Bench, 'cwd' | 'branch'>,
  forIssue: IssueRef,
  mergedHeads: string[],
): Promise<InspectedWorktree> {
  const path = row.cwd
  const branch = row.branch ?? branchOf(forIssue)
  const present = existsSync(path)
  // repo が改名されても、作った worktree は作った時の checkout に登録されている。
  const checkout = present
    ? dirname(await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    : await checkoutOnDisk(ghq, forIssue.repo)
  if (!checkout) {
    return { path, branch, checkout, present, branchExists: false, mergedHeads, refusals: [] }
  }
  const branchExists = await succeeds(
    git(checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`),
  )
  const refusals: CloseRefusal[] = []
  if (present && (await git(path, 'status', '--porcelain', '--untracked-files=normal')) !== '') {
    refusals.push({ kind: 'uncommitted_changes', worktree: path })
  }
  if (branchExists && (await hasUnpublishedCommits(checkout, branch, mergedHeads))) {
    refusals.push({ kind: 'unpublished_commits', branch })
  }
  return { path, branch, checkout, present, branchExists, mergedHeads, refusals }
}

/** force でなければ、調べた後に worktree に書かれた変更は git が断り、積まれた commit の branch は残す。 */
export async function removeWorktree(
  { path, branch, checkout, present, branchExists, mergedHeads }: InspectedWorktree,
  { force }: { force: boolean },
) {
  if (!checkout) return { removedWorktree: null, deletedBranch: null, warnings: [] }
  if (present) {
    await git(checkout, 'worktree', 'remove', ...(force ? ['--force'] : []), path)
  } else {
    // 登録が残るとその branch を消せないので、関係の無い登録まで外す prune ではなく、この path の登録だけを外す。
    await succeeds(git(checkout, 'worktree', 'remove', '--force', path))
  }
  const removedWorktree = present ? path : null
  if (!branchExists) return { removedWorktree, deletedBranch: null, warnings: [] }
  // worktree を外した後は、この branch に commit が積まれない。
  if (!force && (await hasUnpublishedCommits(checkout, branch, mergedHeads))) {
    return {
      removedWorktree,
      deletedBranch: null,
      warnings: [`branch ${branch} got commits on no remote while closing, so it stays`],
    }
  }
  await git(checkout, 'branch', '-D', branch)
  return { removedWorktree, deletedBranch: branch, warnings: [] }
}

// fetch しないので push した commit は merge されていなくても数えず、squash merge で remote から消えた commit も手元にある merged PR の head から辿れれば数えない。
// remote で rebase してから merge された branch の commit は head から辿れないので、同じ patch が head にあるかで見る。
async function hasUnpublishedCommits(
  checkout: string,
  branch: string,
  mergedHeads: string[],
): Promise<boolean> {
  const commits = await git(
    checkout,
    'rev-list',
    '--ignore-missing',
    `refs/heads/${branch}`,
    '--not',
    '--remotes',
    ...mergedHeads,
  )
  if (commits === '') return false
  const heads = await presentCommits(checkout, mergedHeads)
  if (heads.length === 0) return true
  const merged = new Set(
    (await patchIds(checkout, [...heads, '--not', `refs/heads/${branch}`])).map(
      ({ patchId }) => patchId,
    ),
  )
  const landed = new Set(
    (await patchIds(checkout, ['--no-walk', ...commits.split('\n')]))
      .filter(({ patchId }) => merged.has(patchId))
      .map(({ commit }) => commit),
  )
  return commits.split('\n').some((commit) => !landed.has(commit))
}

async function presentCommits(checkout: string, commits: string[]): Promise<string[]> {
  const present: string[] = []
  for (const commit of commits) {
    if (await succeeds(git(checkout, 'cat-file', '-e', `${commit}^{commit}`))) present.push(commit)
  }
  return present
}

// git cherry と既定の git patch-id は空白を除いて比べるので、空白だけ違う commit まで同じ patch とみなす。
async function patchIds(
  checkout: string,
  revisions: string[],
): Promise<{ patchId: string; commit: string }[]> {
  // 文字列を経ると UTF-8 でない byte が置換文字に潰れ、違う patch が同じ patch-id になる。
  const ids = await gitPiped(
    checkout,
    ['log', '--patch', '--no-color', '--no-ext-diff', '--format=commit %H', ...revisions],
    ['patch-id', '--verbatim'],
  )
  return ids
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [patchId = '', commit = ''] = line.split(' ')
      return { patchId, commit }
    })
}

async function checkoutOnDisk(ghq: Ghq, repo: string): Promise<string | null> {
  const checkout = await checkoutOf(ghq, repo)
  return existsSync(checkout) ? checkout : null
}
