import { and, desc, eq, isNull } from 'drizzle-orm'

import { EMPTY_DOC } from './body/index.ts'
import { type EssaySummary, logicalDate, type Note } from './contract.ts'
import type { Db } from './db.ts'
import { isRepo, type NoteRow, toEssaySummary, toNote } from './row.ts'
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

// 保存しても一覧の中で動かないよう、作った順に並べる。
export function listEssays(db: Db): EssaySummary[] {
  return db
    .select({
      id: note.id,
      title: note.title,
      status: note.status,
      date: note.date,
      preview: note.preview,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })
    .from(note)
    .where(and(eq(note.kind, 'essay'), isNull(note.deletedAt)))
    .orderBy(desc(note.createdAt), desc(note.id))
    .all()
    .map(toEssaySummary)
}

export function createRepoNote(db: Db, repo: string): Note {
  return toNote(insertNote(db, { kind: 'repo_note', repo, title: '' }))
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
