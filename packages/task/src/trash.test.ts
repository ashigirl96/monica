import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { systemJobs } from './server.ts'
import { cleanUp, failure, onCleanup, setup } from './testing.ts'
import { trashOf } from './trash.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

function trashedWorktree(
  home: string,
  name: string,
  { restoreTo, secondsAgo }: { restoreTo?: string; secondsAgo: number },
) {
  const trashed = join(trashOf(home), name)
  mkdirSync(join(trashed, 'tree'), { recursive: true })
  writeFileSync(join(trashed, 'tree/draft.txt'), 'draft\n')
  if (restoreTo !== undefined) writeFileSync(join(trashed, 'restore-to'), `${restoreTo}\n`)
  const at = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(trashed, at, at)
  return trashed
}

test('the system Job task.worktree-sweep deletes the trashed worktrees older than a minute that have passed the guard', async () => {
  const { taskLedger, home } = setup()
  const old = trashedWorktree(home, 'old', { secondsAgo: 61 })

  await systemJobs(taskLedger)
    .find((job) => job.name === 'task.worktree-sweep')!
    .run()

  expect(existsSync(old)).toBe(false)
})

test('the sweep leaves a trashed worktree that has not passed the guard, and one moved aside less than a minute ago', async () => {
  const { taskLedger, home } = setup()
  const unguarded = trashedWorktree(home, 'unguarded', {
    restoreTo: join(home, 'worktrees/acme/app/issue-12'),
    secondsAgo: 3600,
  })
  const recent = trashedWorktree(home, 'recent', { secondsAgo: 30 })

  await taskLedger.sweepTrashedWorktrees()

  expect(existsSync(join(unguarded, 'tree/draft.txt'))).toBe(true)
  expect(existsSync(join(recent, 'tree/draft.txt'))).toBe(true)
})

test('a trashed worktree the sweep cannot delete fails it on one line after the others are gone', async () => {
  const { taskLedger, home } = setup()
  const stuck = trashedWorktree(home, 'a-stuck', { secondsAgo: 61 })
  chmodSync(join(stuck, 'tree'), 0o555)
  onCleanup(() => chmodSync(join(stuck, 'tree'), 0o755))
  const removable = trashedWorktree(home, 'b-removable', { secondsAgo: 61 })

  const error = await failure(taskLedger.sweepTrashedWorktrees())

  expect(existsSync(removable)).toBe(false)
  expect(existsSync(join(stuck, 'tree/draft.txt'))).toBe(true)
  expect(error.message).toStartWith('could not delete the trashed worktrees: ')
  expect(error.message).toContain(stuck)
})

test('start puts a trashed worktree that had not passed the guard back at its path, and drops a mark whose move never happened', () => {
  const { taskLedger, home } = setup()
  const path = join(home, 'worktrees/acme/app/issue-12')
  const trashed = trashedWorktree(home, 'interrupted', { restoreTo: path, secondsAgo: 3600 })
  const unmoved = join(trashOf(home), 'unmoved')
  mkdirSync(unmoved)
  writeFileSync(join(unmoved, 'restore-to'), `${join(home, 'worktrees/acme/app/issue-13')}\n`)

  taskLedger.start()

  expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('draft\n')
  expect(existsSync(trashed)).toBe(false)
  expect(existsSync(unmoved)).toBe(false)
})

test('start leaves a trashed worktree whose path is taken where it is, with its mark', () => {
  const { taskLedger, home } = setup()
  const path = join(home, 'worktrees/acme/app/issue-12')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'reopened.txt'), 'reopened\n')
  const trashed = trashedWorktree(home, 'interrupted', { restoreTo: path, secondsAgo: 3600 })
  const stderr = spyOn(console, 'error').mockImplementation(() => {})

  taskLedger.start()

  expect(existsSync(join(trashed, 'tree/draft.txt'))).toBe(true)
  expect(existsSync(join(trashed, 'restore-to'))).toBe(true)
  expect(existsSync(join(path, 'reopened.txt'))).toBe(true)
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(trashed))
})
