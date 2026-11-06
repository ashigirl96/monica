import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'

import { migrations } from '../migrations/index.ts'
import { note } from './schema.ts'

type Row = typeof note.$inferInsert

function inMemoryDb() {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  return db
}

const at = new Date(2026, 9, 6, 12, 0)
const base = { date: '2026-10-06', content: '{}', createdAt: at, updatedAt: at }
const insert = (db: ReturnType<typeof inMemoryDb>, row: Partial<Row>) =>
  db
    .insert(note)
    .values({ kind: 'daily', ...base, ...row })
    .run()

test.each<[string, Partial<Row>]>([
  ['a Daily', { kind: 'daily' }],
  ['an Essay', { kind: 'essay', title: '', status: 'writing' }],
  ['a deleted Essay', { kind: 'essay', title: 't', status: 'finished', deletedAt: at }],
  ['a Repo Note', { kind: 'repo_note', repo: 'owner/repo', title: '' }],
  ['a deleted Repo Note', { kind: 'repo_note', repo: 'owner/repo', title: 't', deletedAt: at }],
  ['a Scratch', { kind: 'scratch', repo: 'owner/repo' }],
  ['a Pad', { kind: 'pad' }],
  ['a starred Essay', { kind: 'essay', title: '', status: 'writing', starred: true }],
  ['a starred Repo Note', { kind: 'repo_note', repo: 'owner/repo', title: '', starred: true }],
])('the table takes %s', (_name, row) => {
  expect(() => insert(inMemoryDb(), row)).not.toThrow()
})

test.each<[string, Partial<Row>, string]>([
  ['a kind no Note has', { kind: 'memo' as 'daily' }, 'note_kind'],
  ['a Daily with a title', { kind: 'daily', title: '' }, 'note_title'],
  ['a Daily with a status', { kind: 'daily', status: 'writing' }, 'note_status'],
  ['a Daily with a Repo', { kind: 'daily', repo: 'owner/repo' }, 'note_repo'],
  ['a deleted Daily', { kind: 'daily', deletedAt: at }, 'note_deleted_at'],
  ['an Essay with no title', { kind: 'essay', status: 'writing' }, 'note_title'],
  ['an Essay with no status', { kind: 'essay', title: '' }, 'note_status'],
  [
    'an Essay with a status no Essay has',
    { kind: 'essay', title: '', status: 'drafting' as 'writing' },
    'note_status',
  ],
  [
    'an Essay with a Repo',
    { kind: 'essay', title: '', status: 'writing', repo: 'owner/repo' },
    'note_repo',
  ],
  ['a Repo Note with no title', { kind: 'repo_note', repo: 'owner/repo' }, 'note_title'],
  [
    'a Repo Note with a status',
    { kind: 'repo_note', repo: 'owner/repo', title: '', status: 'writing' },
    'note_status',
  ],
  ['a Repo Note with no Repo', { kind: 'repo_note', title: '' }, 'note_repo'],
  ['a Scratch with a title', { kind: 'scratch', repo: 'owner/repo', title: '' }, 'note_title'],
  ['a Scratch with no Repo', { kind: 'scratch' }, 'note_repo'],
  ['a deleted Scratch', { kind: 'scratch', repo: 'owner/repo', deletedAt: at }, 'note_deleted_at'],
  ['a starred Daily', { kind: 'daily', starred: true }, 'note_starred'],
  ['a starred Scratch', { kind: 'scratch', repo: 'owner/repo', starred: true }, 'note_starred'],
  ['a Pad with a title', { kind: 'pad', title: '' }, 'note_title'],
  ['a Pad with a Repo', { kind: 'pad', repo: 'owner/repo' }, 'note_repo'],
  ['a deleted Pad', { kind: 'pad', deletedAt: at }, 'note_deleted_at'],
  ['a starred Pad', { kind: 'pad', starred: true }, 'note_starred'],
])('the table refuses %s', (_name, row, constraint) => {
  expect(() => insert(inMemoryDb(), row)).toThrow(`CHECK constraint failed: ${constraint}`)
})

test('the table takes one Daily per date', () => {
  const db = inMemoryDb()
  insert(db, { kind: 'daily', date: '2026-10-06' })
  insert(db, { kind: 'daily', date: '2026-10-07' })
  insert(db, { kind: 'essay', title: '', status: 'writing', date: '2026-10-06' })

  expect(() => insert(db, { kind: 'daily', date: '2026-10-06' })).toThrow(
    'UNIQUE constraint failed: note.date',
  )
})

test('the table takes one Scratch per Repo, whatever its case', () => {
  const db = inMemoryDb()
  insert(db, { kind: 'scratch', repo: 'Owner/Repo' })
  insert(db, { kind: 'scratch', repo: 'owner/other' })
  insert(db, { kind: 'repo_note', repo: 'owner/repo', title: '' })

  expect(() => insert(db, { kind: 'scratch', repo: 'owner/repo' })).toThrow(
    'UNIQUE constraint failed: index',
  )
})

test('the table takes one Pad', () => {
  const db = inMemoryDb()
  insert(db, { kind: 'pad', date: '2026-10-06' })
  insert(db, { kind: 'daily', date: '2026-10-06' })

  expect(() => insert(db, { kind: 'pad', date: '2026-10-07' })).toThrow(
    'UNIQUE constraint failed: note.kind',
  )
})

test('remaking the table for the Pad keeps the rows, the Scratch per Repo, and the used ids', () => {
  const sqlite = new Database(':memory:')
  const [first, second, third] = readMigrationFiles({ migrationsFolder: migrations.folder })
  const apply = (m: { sql: string[] } | undefined) => {
    for (const statement of m!.sql) sqlite.run(statement)
  }
  apply(first)
  apply(second)
  const db = drizzle(sqlite)
  insert(db, { kind: 'daily', date: '2026-10-06' })
  insert(db, { kind: 'scratch', repo: 'Owner/Repo' })
  insert(db, { kind: 'essay', title: 't', status: 'finished', deletedAt: at, starred: true })
  insert(db, { kind: 'daily', date: '2026-10-07' })
  sqlite.run('DELETE FROM note WHERE id = 4')

  apply(third)

  expect(db.select({ id: note.id, kind: note.kind }).from(note).all()).toEqual([
    { id: 1, kind: 'daily' },
    { id: 2, kind: 'scratch' },
    { id: 3, kind: 'essay' },
  ])
  expect(() => insert(db, { kind: 'scratch', repo: 'owner/repo' })).toThrow(
    'UNIQUE constraint failed: index',
  )
  insert(db, { kind: 'pad' })
  expect(db.select({ id: note.id }).from(note).where(eq(note.kind, 'pad')).get()).toEqual({ id: 5 })
})
