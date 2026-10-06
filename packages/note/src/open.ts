import { and, desc, eq, sql } from 'drizzle-orm'

import { EMPTY_DOC } from './body/index.ts'
import { logicalDate, type Note } from './contract.ts'
import type { Db } from './note.ts'
import { type NoteRow, toNote } from './row.ts'
import { note } from './schema.ts'

// bun:sqlite は同期なので、SELECT と INSERT の間に他の request は割り込まない。
export function openDaily(db: Db, date: string): Note {
  const found = db
    .select()
    .from(note)
    .where(and(eq(note.kind, 'daily'), eq(note.date, date)))
    .get()
  return toNote(found ?? insertNote(db, { kind: 'daily', date }))
}

export function dailyDates(db: Db): string[] {
  return db
    .select({ date: note.date })
    .from(note)
    .where(eq(note.kind, 'daily'))
    .orderBy(desc(note.date))
    .all()
    .map((row) => row.date)
}

export function openScratch(db: Db, repo: string): Note {
  const found = db
    .select()
    .from(note)
    .where(and(eq(note.kind, 'scratch'), isRepo(repo)))
    .get()
  return toNote(found ?? insertNote(db, { kind: 'scratch', repo }))
}

export function createEssay(db: Db): Note {
  return toNote(insertNote(db, { kind: 'essay', title: '', status: 'writing' }))
}

export function createRepoNote(db: Db, repo: string): Note {
  return toNote(insertNote(db, { kind: 'repo_note', repo, title: '' }))
}

// GitHub の repo 名は大文字と小文字を区別しない。
function isRepo(repo: string) {
  return eq(sql`lower(${note.repo})`, repo.toLowerCase())
}

function insertNote(
  db: Db,
  values: Pick<typeof note.$inferInsert, 'kind' | 'repo' | 'title' | 'status'> & { date?: string },
): NoteRow {
  const at = new Date()
  return db
    .insert(note)
    .values({
      date: logicalDate(at),
      ...values,
      content: JSON.stringify(EMPTY_DOC),
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get()
}
