import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { cleanUp, commitEmpty, ghqCheckout, git, setup } from './testing.ts'

afterEach(cleanUp)

test('a directory in a checkout in the ghq layout, or in a worktree of it elsewhere, is in that Repo, shown from the top of that checkout or worktree', async () => {
  const { client } = setup()
  const { checkout, worktree } = ghqCheckout('acme/app')
  mkdirSync(join(checkout, 'packages', 'ui', 'src'), { recursive: true })
  mkdirSync(join(worktree, 'src'))

  expect(await client.repo.of({ cwd: checkout })).toEqual({
    repo: 'acme/app',
    path: 'app',
    branch: null,
  })
  expect(await client.repo.of({ cwd: join(checkout, 'packages', 'ui', 'src') })).toEqual({
    repo: 'acme/app',
    path: 'packages/ui/src',
    branch: null,
  })
  expect(await client.repo.of({ cwd: worktree })).toEqual({
    repo: 'acme/app',
    path: 'issue-1',
    branch: 'issue-1',
  })
  expect(await client.repo.of({ cwd: join(worktree, 'src') })).toEqual({
    repo: 'acme/app',
    path: 'src',
    branch: 'issue-1',
  })
})

test('a checkout in the ghq layout without a commit, and a directory in it, are in that Repo before and after the first commit', async () => {
  const { client } = setup()
  const { root } = ghqCheckout('acme/app')
  const checkout = join(root, 'ghq', 'github.com', 'acme', 'fresh')
  git(root, 'init', '--initial-branch=main', checkout)
  mkdirSync(join(checkout, 'src'))

  expect(await client.repo.of({ cwd: checkout })).toEqual({
    repo: 'acme/fresh',
    path: 'fresh',
    branch: null,
  })
  expect(await client.repo.of({ cwd: join(checkout, 'src') })).toEqual({
    repo: 'acme/fresh',
    path: 'src',
    branch: null,
  })
  commitEmpty(checkout)
  expect(await client.repo.of({ cwd: join(checkout, 'src') })).toEqual({
    repo: 'acme/fresh',
    path: 'src',
    branch: null,
  })
})

test('a detached worktree of a checkout in the ghq layout is in that Repo without a branch', async () => {
  const { client } = setup()
  const { root, checkout } = ghqCheckout('acme/app')
  const detached = join(root, 'worktrees', 'acme', 'app', 'detached')
  git(checkout, 'worktree', 'add', '--detach', detached)

  expect(await client.repo.of({ cwd: detached })).toEqual({
    repo: 'acme/app',
    path: 'detached',
    branch: null,
  })
})

test('a git repo outside the ghq layout, a directory outside any repo, and a missing directory are in no Repo, shown by their path', async () => {
  const { client } = setup()
  const { root, elsewhere } = ghqCheckout('acme/app')

  for (const cwd of [elsewhere, root, join(root, 'missing')]) {
    expect(await client.repo.of({ cwd })).toEqual({ repo: null, path: cwd, branch: null })
  }
})

test('a directory under the home outside any Repo is shown from ~', async () => {
  const { client } = setup()

  expect(await client.repo.of({ cwd: join(homedir(), 'monica-missing', 'Downloads') })).toEqual({
    repo: null,
    path: '~/monica-missing/Downloads',
    branch: null,
  })
})
