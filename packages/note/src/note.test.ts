import { Database } from 'bun:sqlite'
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { createRouterClient } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { idNumber } from './row.ts'
import { note } from './schema.ts'
import { createNoteLedger, migrations, router } from './server.ts'

afterEach(() => {
  setSystemTime()
})

function setup() {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home: tmpdir() })
  const client = createRouterClient(router, { context: { db, noteLedger } })
  return { db, client }
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

const block = (id: string | null, text: string, nested: object[] = []) => ({
  type: 'blockContainer' as const,
  attrs: { id },
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    ...(nested.length > 0 ? [{ type: 'blockGroup', content: nested }] : []),
  ],
})

const docOf = (...blocks: object[]) => ({
  type: 'doc' as const,
  content: [{ type: 'blockGroup', content: blocks }],
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the call to fail')
}

test('opening the Daily of a date twice gives the same Note, and another date, even a future one, has its own', async () => {
  const { client } = setup()

  const first = await client.daily.open({ date: '2026-10-06' })
  const again = await client.daily.open({ date: '2026-10-06' })
  const future = await client.daily.open({ date: '2099-01-01' })

  expect(first).toMatchObject({ kind: 'daily', date: '2026-10-06' })
  expect(again.id).toBe(first.id)
  expect(future).toMatchObject({ kind: 'daily', date: '2099-01-01' })
  expect(future.id).not.toBe(first.id)
})

test('the dates with a Daily come newest first, and the date of a Note of another kind is not among them', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 7, 12))

  expect(await client.daily.dates()).toEqual([])

  await client.daily.open({ date: '2026-10-06' })
  await client.daily.open({ date: '2099-01-01' })
  await client.daily.open({ date: '2025-12-31' })
  await client.daily.open({ date: '2026-10-06' })
  await client.essay.create()

  expect(await client.daily.dates()).toEqual(['2099-01-01', '2026-10-06', '2025-12-31'])
})

test('opening the Scratch of a Repo gives the same Note whatever the case of the Repo, which keeps its first spelling', async () => {
  const { client } = setup()

  const first = await client.scratch.open({ repo: 'Owner/Repo' })
  const again = await client.scratch.open({ repo: 'owner/repo' })
  const other = await client.scratch.open({ repo: 'owner/other' })

  expect(first).toMatchObject({ kind: 'scratch', repo: 'Owner/Repo' })
  expect(again).toEqual(first)
  expect(other.id).not.toBe(first.id)
})

test('an Essay is made writing with no title, and a Repo Note with no title in its Repo, both on the Logical Date they are made', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 6, 4, 30))

  const essay = await client.essay.create()
  const repoNote = await client.repoNote.create({ repo: 'Owner/Repo' })
  const another = await client.repoNote.create({ repo: 'owner/repo' })

  expect(essay).toMatchObject({ kind: 'essay', title: '', status: 'writing', date: '2026-10-05' })
  expect(repoNote).toMatchObject({
    kind: 'repo_note',
    repo: 'Owner/Repo',
    title: '',
    date: '2026-10-05',
  })
  expect(another.id).not.toBe(repoNote.id)
  expect(await client.get({ id: essay.id })).toEqual(essay)
})

test('a Repo that is not owner/repo and a date not on the calendar are refused', async () => {
  const { client } = setup()

  for (const repo of ['owner', 'owner/repo/tree', 'https://github.com/owner/repo']) {
    expect((await failure(client.repoNote.create({ repo }))).code).toBe('BAD_REQUEST')
    expect((await failure(client.scratch.open({ repo }))).code).toBe('BAD_REQUEST')
  }
  for (const date of ['2026-02-30', '2026-7-4']) {
    expect((await failure(client.daily.open({ date }))).code).toBe('BAD_REQUEST')
  }
})

test('saving on the version it read writes the body and the title, moves updatedAt on and makes the preview anew', async () => {
  const { client, db } = setup()
  const essay = await client.essay.create()

  const first = await client.save({
    id: essay.id,
    content: doc('first line'),
    title: 'On ledgers',
    expectedUpdatedAt: essay.updatedAt,
  })
  const second = await client.save({
    id: essay.id,
    content: doc('second line'),
    expectedUpdatedAt: first.updatedAt,
  })

  expect(first.updatedAt.getTime()).toBeGreaterThan(essay.updatedAt.getTime())
  expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime())
  expect(await client.get({ id: essay.id })).toMatchObject({
    title: 'On ledgers',
    content: doc('second line'),
    updatedAt: second.updatedAt,
  })
  const row = db
    .select()
    .from(note)
    .where(eq(note.id, idNumber(essay.id)))
    .get()
  expect(row?.preview).toBe('second line')
})

test('saving on an old version fails with CONFLICT and leaves the body, even when both saves fall in the same millisecond', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 6, 12, 0))
  const daily = await client.daily.open({ date: '2026-10-06' })
  const mine = await client.save({
    id: daily.id,
    content: doc('mine'),
    expectedUpdatedAt: daily.updatedAt,
  })

  const error = await failure(
    client.save({ id: daily.id, content: doc('theirs'), expectedUpdatedAt: daily.updatedAt }),
  )

  expect(error.code).toBe('CONFLICT')
  expect(await client.get({ id: daily.id })).toMatchObject({
    content: doc('mine'),
    updatedAt: mine.updatedAt,
  })
})

test('a title is refused for a Daily and a Scratch, and the body is left', async () => {
  const { client } = setup()
  const daily = await client.daily.open({ date: '2026-10-06' })
  const scratch = await client.scratch.open({ repo: 'owner/repo' })

  for (const { id, updatedAt } of [daily, scratch]) {
    const error = await failure(
      client.save({ id, content: doc('text'), title: 'title', expectedUpdatedAt: updatedAt }),
    )

    expect(error.code).toBe('BAD_REQUEST')
    expect(await client.get({ id })).toMatchObject({ content: daily.content, updatedAt })
  }
})

test('a Daily and a Scratch cannot be deleted', async () => {
  const { client } = setup()
  const daily = await client.daily.open({ date: '2026-10-06' })
  const scratch = await client.scratch.open({ repo: 'owner/repo' })

  for (const kept of [daily, scratch]) {
    expect((await failure(client.remove({ id: kept.id }))).code).toBe('BAD_REQUEST')
    expect(await client.get({ id: kept.id })).toEqual(kept)
  }
})

test('a deleted Essay or Repo Note is not found until the deletion is undone, and neither moves updatedAt', async () => {
  const { client } = setup()

  for (const made of [await client.essay.create(), await client.repoNote.create({ repo: 'o/r' })]) {
    const { id } = made
    await client.remove({ id })

    expect((await failure(client.get({ id }))).code).toBe('NOT_FOUND')
    expect(
      (await failure(client.save({ id, content: doc('text'), expectedUpdatedAt: made.updatedAt })))
        .code,
    ).toBe('NOT_FOUND')
    expect((await failure(client.remove({ id }))).code).toBe('NOT_FOUND')
    expect(await client.restore({ id })).toEqual(made)
    expect(await client.get({ id })).toEqual(made)
  }
})

test('an id no Note has is not found', async () => {
  const { client } = setup()

  for (const call of [client.get, client.remove, client.restore]) {
    expect((await failure(call({ id: 'note-999' }))).code).toBe('NOT_FOUND')
  }
})

test('an Essay is set to finished and back, each change moving updatedAt on; setting the status it has changes nothing', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 6, 12, 0))
  const essay = await client.essay.create()

  const finished = await client.essay.setStatus({ id: essay.id, status: 'finished' })
  const unchanged = await client.essay.setStatus({ id: essay.id, status: 'finished' })
  const writing = await client.essay.setStatus({ id: essay.id, status: 'writing' })

  expect(finished).toMatchObject({ status: 'finished' })
  expect(finished.updatedAt.getTime()).toBeGreaterThan(essay.updatedAt.getTime())
  expect(unchanged).toEqual(finished)
  expect(writing).toMatchObject({ status: 'writing' })
  expect(writing.updatedAt.getTime()).toBeGreaterThan(finished.updatedAt.getTime())
})

test('the Note Mention candidates are the Notes whose title, name, preview or Repo has the query, whatever its case', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 6, 12))
  const essay = await client.essay.create()
  await client.save({
    id: essay.id,
    content: doc('first line'),
    title: 'On Ledgers',
    expectedUpdatedAt: essay.updatedAt,
  })
  const daily = await client.daily.open({ date: '2026-10-01' })
  await client.save({
    id: daily.id,
    content: doc('Met the plumber'),
    expectedUpdatedAt: daily.updatedAt,
  })
  const repoNote = await client.repoNote.create({ repo: 'ashigirl96/tania' })
  const scratch = await client.scratch.open({ repo: 'owner/Monica' })
  const untitled = await client.essay.create()

  const ids = async (q: string) => (await client.noteMention.search({ q })).map(({ id }) => id)

  expect(await client.noteMention.search({ q: 'ledger' })).toEqual([
    { id: essay.id, displayName: 'On Ledgers', preview: 'first line' },
  ])
  expect(await ids('2026-10-01')).toEqual([daily.id])
  expect(await ids('PLUMBER')).toEqual([daily.id])
  expect(await ids('tania')).toEqual([repoNote.id])
  expect(await ids('monica')).toEqual([scratch.id])
  expect(await ids('untitled')).toEqual([untitled.id, repoNote.id])
  expect(await ids('2026-10-06')).toEqual([])
})

test('at most 20 candidates come, the most recently updated first', async () => {
  const { client } = setup()
  const essays = []
  for (let minute = 0; minute < 25; minute++) {
    setSystemTime(new Date(2026, 9, 6, 12, minute))
    essays.push(await client.essay.create())
  }
  setSystemTime(new Date(2026, 9, 6, 13))
  const edited = essays[2]!
  await client.save({ id: edited.id, content: doc('x'), expectedUpdatedAt: edited.updatedAt })

  const found = await client.noteMention.search({ q: '' })

  expect(found).toHaveLength(20)
  expect(found.map(({ id }) => id)).toEqual([
    edited.id,
    ...essays
      .slice(6)
      .toReversed()
      .map(({ id }) => id),
  ])
})

test('a match comes even behind more than 20 more recently updated Notes that do not match', async () => {
  const { client } = setup()
  setSystemTime(new Date(2026, 9, 6, 11))
  const needle = await client.essay.create()
  await client.save({
    id: needle.id,
    content: doc('x'),
    title: 'Needle',
    expectedUpdatedAt: needle.updatedAt,
  })
  for (let day = 1; day <= 25; day++) {
    setSystemTime(new Date(2026, 9, 6, 12, day))
    await client.daily.open({ date: `2026-09-${String(day).padStart(2, '0')}` })
  }

  expect((await client.noteMention.search({ q: 'needle' })).map(({ id }) => id)).toEqual([
    needle.id,
  ])
})

test('a deleted Note is not a candidate until the deletion is undone', async () => {
  const { client } = setup()
  const essay = await client.essay.create()
  await client.remove({ id: essay.id })

  expect(await client.noteMention.search({ q: 'untitled' })).toEqual([])

  await client.restore({ id: essay.id })

  expect((await client.noteMention.search({ q: 'untitled' })).map(({ id }) => id)).toEqual([
    essay.id,
  ])
})

test('a Note Mention resolves to the name the Note has now', async () => {
  const { client } = setup()
  const essay = await client.essay.create()
  const daily = await client.daily.open({ date: '2026-10-06' })

  expect(await client.noteMention.resolve({ id: essay.id })).toEqual({ displayName: 'Untitled' })
  expect(await client.noteMention.resolve({ id: daily.id })).toEqual({ displayName: '2026-10-06' })

  await client.save({
    id: essay.id,
    content: essay.content,
    title: 'On ledgers',
    expectedUpdatedAt: essay.updatedAt,
  })

  expect(await client.noteMention.resolve({ id: essay.id })).toEqual({ displayName: 'On ledgers' })
})

test('a Note Mention to a deleted Note, to an id no Note has, or to something that is no Note id is not found', async () => {
  const { client } = setup()
  const kept = await client.essay.create()
  const essay = await client.essay.create()
  await client.remove({ id: essay.id })

  expect(kept.id).toBe('note-1')
  for (const id of [essay.id, 'note-999', 'abc', 'note-01']) {
    expect((await failure(client.noteMention.resolve({ id }))).code).toBe('NOT_FOUND')
  }
})

test('a block comes with the blocks nested in it, found at any depth', async () => {
  const { client } = setup()
  const daily = await client.daily.open({ date: '2026-10-06' })
  const child = block('child', 'nested')
  const parent = block('parent', 'outer', [child])
  await client.save({
    id: daily.id,
    content: docOf(block(null, 'no id'), parent),
    expectedUpdatedAt: daily.updatedAt,
  })

  expect(await client.block.get({ id: daily.id, blockId: 'parent' })).toEqual(parent)
  expect(await client.block.get({ id: daily.id, blockId: 'child' })).toEqual(child)
})

test('a block is not found when the Note has no block of that id, the Note is deleted, or no Note has the id', async () => {
  const { client } = setup()
  const essay = await client.essay.create()
  await client.save({
    id: essay.id,
    content: docOf(block('kept', 'text')),
    expectedUpdatedAt: essay.updatedAt,
  })

  expect(essay.id).toBe('note-1')
  for (const [id, blockId] of [
    [essay.id, 'gone'],
    ['note-01', 'kept'],
  ] as const) {
    expect((await failure(client.block.get({ id, blockId }))).code).toBe('NOT_FOUND')
  }

  await client.remove({ id: essay.id })

  for (const id of [essay.id, 'note-999', 'abc']) {
    expect((await failure(client.block.get({ id, blockId: 'kept' }))).code).toBe('NOT_FOUND')
  }
})

test('only an Essay has a status', async () => {
  const { client } = setup()
  const others = [
    await client.daily.open({ date: '2026-10-06' }),
    await client.scratch.open({ repo: 'owner/repo' }),
    await client.repoNote.create({ repo: 'owner/repo' }),
  ]

  for (const { id } of others) {
    expect((await failure(client.essay.setStatus({ id, status: 'finished' }))).code).toBe(
      'BAD_REQUEST',
    )
  }
})
