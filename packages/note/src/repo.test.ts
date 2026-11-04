import { Database } from 'bun:sqlite'
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { createNoteLedger, type Ghq, migrations, router } from './server.ts'

const roots: string[] = []

afterEach(() => {
  setSystemTime()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const failingGhq: Ghq = { root: () => Promise.reject(new Error('no ghq root')) }

function setup(ghq = failingGhq) {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home: tmpdir(), ghq })
  return createRouterClient(router, { context: { db, noteLedger } })
}

function ghqRootWith(...dirs: string[]): Ghq {
  const root = mkdtempSync(join(tmpdir(), 'monica-ghq-'))
  roots.push(root)
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  return { root: () => Promise.resolve(root) }
}

function checkouts(...paths: string[]): Ghq {
  return ghqRootWith(...paths.map((path) => `${path}/.git`))
}

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [
    {
      type: 'blockGroup',
      content: [
        {
          type: 'blockContainer',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      ],
    },
  ],
})

test('the Repo Notes of a Repo come 100 a page, newest day first, and one made between pages does not come again', async () => {
  const client = setup()
  setSystemTime(new Date(2026, 9, 6, 12))
  const made = []
  for (let i = 0; i < 101; i++) made.push(await client.repoNote.create({ repo: 'owner/repo' }))
  // 後から作ったが、日付は前の日。
  setSystemTime(new Date(2026, 9, 5, 12))
  const earlier = await client.repoNote.create({ repo: 'owner/repo' })
  setSystemTime(new Date(2026, 9, 6, 13))
  await client.scratch.open({ repo: 'owner/repo' })
  await client.repoNote.create({ repo: 'other/repo' })
  const deleted = await client.repoNote.create({ repo: 'owner/repo' })
  await client.remove({ id: deleted.id })

  const first = await client.repoNote.list({ repo: 'Owner/Repo' })
  await client.repoNote.create({ repo: 'owner/repo' })
  const second = await client.repoNote.list({ repo: 'owner/repo', after: first.next! })

  expect(first.notes.map((n) => n.id)).toEqual(
    made
      .slice(1)
      .map((n) => n.id)
      .toReversed(),
  )
  expect(second.notes.map((n) => n.id)).toEqual([made[0]!.id, earlier.id])
  expect(second.next).toBeNull()
})

test('a Repo Note in the list has its title and the first line of its body, not the body', async () => {
  const client = setup()
  const repoNote = await client.repoNote.create({ repo: 'owner/repo' })
  await client.save({
    id: repoNote.id,
    content: doc('first line'),
    title: 'Plan',
    expectedUpdatedAt: repoNote.updatedAt,
  })
  const untouched = await client.repoNote.create({ repo: 'owner/repo' })

  const { notes, next } = await client.repoNote.list({ repo: 'owner/repo' })

  expect(notes).toEqual([
    {
      id: untouched.id,
      date: untouched.date,
      title: '',
      preview: null,
      updatedAt: untouched.updatedAt,
      starred: false,
    },
    {
      id: repoNote.id,
      date: repoNote.date,
      title: 'Plan',
      preview: 'first line',
      updatedAt: expect.any(Date),
      starred: false,
    },
  ])
  expect(next).toBeNull()
})

test('the Repos with a Note come first, most recently updated first, then the other ghq checkouts under github.com', async () => {
  const client = setup(
    checkouts(
      'github.com/zeta/last',
      'github.com/Alpha/Scratch',
      'gitlab.com/other/host',
      'github.com/beta/noted',
    ),
  )
  setSystemTime(new Date(2026, 9, 6, 9))
  await client.scratch.open({ repo: 'alpha/scratch' })
  setSystemTime(new Date(2026, 9, 6, 10))
  const repoNote = await client.repoNote.create({ repo: 'Beta/Noted' })
  setSystemTime(new Date(2026, 9, 6, 11))
  await client.repoNote.create({ repo: 'gamma/unchecked' })
  setSystemTime(new Date(2026, 9, 6, 12))
  await client.save({ id: repoNote.id, content: doc('x'), expectedUpdatedAt: repoNote.updatedAt })
  setSystemTime(new Date(2026, 9, 6, 13))
  await client.essay.create()
  await client.daily.open({ date: '2026-10-06' })

  expect(await client.repo.candidates()).toEqual([
    'Beta/Noted',
    'gamma/unchecked',
    'alpha/scratch',
    'zeta/last',
  ])
})

test('a Repo whose Notes differ only in case comes once, spelled as its most recently updated Note', async () => {
  const client = setup(checkouts('github.com/OWNER/REPO'))
  setSystemTime(new Date(2026, 9, 6, 9))
  await client.scratch.open({ repo: 'Owner/Repo' })
  setSystemTime(new Date(2026, 9, 6, 10))
  await client.repoNote.create({ repo: 'owner/repo' })

  expect(await client.repo.candidates()).toEqual(['owner/repo'])
})

test('a deleted Note neither puts its Repo among the Repos with a Note nor moves it up', async () => {
  const client = setup(checkouts('github.com/checked/out'))
  setSystemTime(new Date(2026, 9, 6, 9))
  await client.repoNote.create({ repo: 'live/repo' })
  setSystemTime(new Date(2026, 9, 6, 10))
  await client.repoNote.create({ repo: 'other/repo' })
  setSystemTime(new Date(2026, 9, 6, 11))
  for (const repo of ['live/repo', 'gone/repo', 'checked/out']) {
    const deleted = await client.repoNote.create({ repo })
    await client.remove({ id: deleted.id })
  }

  expect(await client.repo.candidates()).toEqual(['other/repo', 'live/repo', 'checked/out'])
})

test('a checkout is any directory at github.com/<owner>/<repo> with a .git, linked or not, whether or not it has a commit', async () => {
  const ghq = ghqRootWith(
    'github.com/plain/dir',
    'github.com/deep/repo/nested/.git',
    'github.com/acme/linked',
    'github.com/acme/other/.git',
    'github.com/not_an/owner/.git',
    'elsewhere/.git',
  )
  const root = await ghq.root()
  Bun.spawnSync(['git', 'init', join(root, 'github.com', 'acme', 'fresh')])
  writeFileSync(join(root, 'github.com', 'acme', 'linked', '.git'), 'gitdir: /elsewhere\n')
  symlinkSync(join(root, 'elsewhere'), join(root, 'github.com', 'acme', 'symlinked'))
  const client = setup(ghq)

  expect(await client.repo.candidates()).toEqual([
    'acme/fresh',
    'acme/linked',
    'acme/other',
    'acme/symlinked',
  ])
})

test('when ghq fails or its root has no github.com, the Repos are those with a Note', async () => {
  for (const ghq of [failingGhq, ghqRootWith('gitlab.com/other/host/.git')]) {
    const client = setup(ghq)
    await client.repoNote.create({ repo: 'owner/repo' })

    expect(await client.repo.candidates()).toEqual(['owner/repo'])
  }
})

test('starred Repo Notes come on the first page above the others, even one more than 100 Notes down, and the pages after hold the rest once', async () => {
  const client = setup()
  setSystemTime(new Date(2026, 9, 5, 12))
  const oldest = await client.repoNote.create({ repo: 'owner/repo' })
  const olderStarred = await client.repoNote.create({ repo: 'owner/repo' })
  setSystemTime(new Date(2026, 9, 6, 12))
  const made = []
  for (let i = 0; i < 100; i++) made.push(await client.repoNote.create({ repo: 'owner/repo' }))
  await client.star({ id: oldest.id, starred: true })
  await client.star({ id: made[50]!.id, starred: true })
  await client.star({ id: olderStarred.id, starred: true })
  await client.star({ id: olderStarred.id, starred: false })

  const first = await client.repoNote.list({ repo: 'owner/repo' })
  const second = await client.repoNote.list({ repo: 'owner/repo', after: first.next! })

  const rest = [...made.filter((_, i) => i !== 50).toReversed(), olderStarred]
  expect(first.notes.map((n) => [n.id, n.starred])).toEqual([
    [made[50]!.id, true],
    [oldest.id, true],
    ...rest.slice(0, 98).map((n) => [n.id, false]),
  ])
  expect(second.notes.map((n) => n.id)).toEqual(rest.slice(98).map((n) => n.id))
  expect(second.next).toBeNull()
})

test('when more than 100 Repo Notes are starred, the next page goes on with the starred before the others', async () => {
  const client = setup()
  setSystemTime(new Date(2026, 9, 6, 12))
  const unstarred = await client.repoNote.create({ repo: 'owner/repo' })
  const starred = []
  for (let i = 0; i < 101; i++) {
    const made = await client.repoNote.create({ repo: 'owner/repo' })
    await client.star({ id: made.id, starred: true })
    starred.push(made)
  }

  const first = await client.repoNote.list({ repo: 'owner/repo' })
  const second = await client.repoNote.list({ repo: 'owner/repo', after: first.next! })

  expect(first.notes.map((n) => n.id)).toEqual(
    starred
      .slice(1)
      .map((n) => n.id)
      .toReversed(),
  )
  expect(second.notes.map((n) => n.id)).toEqual([starred[0]!.id, unstarred.id])
})
