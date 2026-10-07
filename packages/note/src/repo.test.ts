import { Database } from 'bun:sqlite'
import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { createNoteLedger, type Ghq, migrations, router } from './server.ts'

afterEach(() => {
  setSystemTime()
  mock.restore()
})

const noCheckouts: Ghq = { list: () => Promise.resolve([]) }

function setup(ghq = noCheckouts) {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home: tmpdir(), ghq })
  return createRouterClient(router, { context: { db, noteLedger } })
}

function checkouts(...paths: string[]): Ghq {
  return { list: () => Promise.resolve(paths) }
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
    },
    {
      id: repoNote.id,
      date: repoNote.date,
      title: 'Plan',
      preview: 'first line',
      updatedAt: expect.any(Date),
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

test('when ghq fails, the Repos are those with a Note', async () => {
  const client = setup({ list: () => Promise.reject(new Error('ghq: command not found')) })
  await client.repoNote.create({ repo: 'owner/repo' })

  expect(await client.repo.candidates()).toEqual(['owner/repo'])
})

test('ghq is cut off after 5 seconds without waiting for it to end, and the Repos are those with a Note', async () => {
  const realSetTimeout = globalThis.setTimeout
  let fireTimeout: (() => void) | undefined
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== 5000) return realSetTimeout(callback, ms)
    fireTimeout = callback
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout)
  const listing = Promise.withResolvers<AbortSignal>()
  // ghq の子が stdout を握って残ると、ghq を止めても list は終わらない。
  const client = setup({
    list: (signal) => {
      listing.resolve(signal)
      return new Promise(() => {})
    },
  })
  await client.repoNote.create({ repo: 'owner/repo' })

  const candidates = client.repo.candidates()
  const signal = await listing.promise
  fireTimeout!()

  expect(await candidates).toEqual(['owner/repo'])
  expect(signal.aborted).toBe(true)
})
