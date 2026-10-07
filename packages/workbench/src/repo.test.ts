import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { cleanUp, ghqCheckout, setup } from './testing.ts'

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

test('a git repo outside the ghq layout, a directory outside any repo, and a missing directory are in no Repo, shown by their path', async () => {
  const { client } = setup()
  const { root, elsewhere } = ghqCheckout('acme/app')

  for (const cwd of [elsewhere, root, join(root, 'missing')]) {
    expect(await client.repo.of({ cwd })).toEqual({ repo: null, path: cwd, branch: null })
  }
})

test('a directory under the home outside any Repo is shown from ~', async () => {
  const { client } = setup()

  expect(await client.repo.of({ cwd: join(homedir(), 'tania-missing', 'Downloads') })).toEqual({
    repo: null,
    path: '~/tania-missing/Downloads',
    branch: null,
  })
})
