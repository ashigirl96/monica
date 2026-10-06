import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

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
