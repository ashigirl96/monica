import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../migrations/index.ts'
import { study, studyConversation, studyMessage, studyRepo } from './schema.ts'

function inMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  return db
}

const at = new Date(2026, 10, 11, 12, 0)

function withStudy() {
  const db = inMemoryDb()
  db.insert(study).values({ id: 'study-1', createdAt: at, lastActiveAt: at }).run()
  return db
}

test('a Study has at most one ongoing Study Conversation', () => {
  const db = withStudy()
  const conversation = (id: string, endedAt: Date | null) =>
    db.insert(studyConversation).values({ id, studyId: 'study-1', startedAt: at, endedAt }).run()

  conversation('sc-1', at)
  conversation('sc-2', at)
  conversation('sc-3', null)

  expect(() => conversation('sc-4', null)).toThrow()
})

test('only a tool row names its tool', () => {
  const db = withStudy()
  db.insert(studyConversation).values({ id: 'sc-1', studyId: 'study-1', startedAt: at }).run()
  const message = (kind: 'user' | 'tool', tool: string | null) =>
    db
      .insert(studyMessage)
      .values({ conversationId: 'sc-1', createdAt: at, kind, text: 'x', tool })
      .run()

  message('tool', 'Read')
  message('user', null)

  expect(() => message('tool', null)).toThrow()
  expect(() => message('user', 'Read')).toThrow()
})

test('removing a Study removes its conversations and messages', () => {
  const db = withStudy()
  db.insert(studyConversation).values({ id: 'sc-1', studyId: 'study-1', startedAt: at }).run()
  db.insert(studyMessage)
    .values({ conversationId: 'sc-1', createdAt: at, kind: 'user', text: 'hi' })
    .run()

  db.delete(study).where(eq(study.id, 'study-1')).run()

  expect(db.select().from(studyConversation).all()).toEqual([])
  expect(db.select().from(studyMessage).all()).toEqual([])
})

test('removing a Study removes its links to Repos', () => {
  const db = withStudy()
  db.insert(studyRepo).values({ studyId: 'study-1', repo: 'acme/alpha', createdAt: at }).run()

  db.delete(study).where(eq(study.id, 'study-1')).run()

  expect(db.select().from(studyRepo).all()).toEqual([])
})

test('a Study links a Repo once whatever its case', () => {
  const db = withStudy()
  db.insert(studyRepo).values({ studyId: 'study-1', repo: 'acme/alpha', createdAt: at }).run()

  expect(() =>
    db.insert(studyRepo).values({ studyId: 'study-1', repo: 'Acme/Alpha', createdAt: at }).run(),
  ).toThrow()
})
