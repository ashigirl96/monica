import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { cleanUp, linkedWorktree, setup } from './testing.ts'

afterEach(cleanUp)

test('a directory in a linked worktree is named by its repo and the branch checked out there', async () => {
  const { client } = setup()
  const { worktree } = linkedWorktree({ repo: 'acme', branch: 'feature/title' })
  mkdirSync(join(worktree, 'src'))

  expect(await client.worktree.info({ cwd: join(worktree, 'src') })).toEqual({
    repo: 'acme',
    branch: 'feature/title',
  })
})

test('the main checkout, a directory outside any repo, and a missing directory are not worktrees', async () => {
  const { client } = setup()
  const { root, repo } = linkedWorktree({ repo: 'acme', branch: 'feature/title' })

  for (const cwd of [repo, root, join(root, 'missing')]) {
    expect(await client.worktree.info({ cwd })).toBeNull()
  }
})
