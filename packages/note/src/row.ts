import { ORPCError } from '@orpc/server'
import { and, eq, isNull } from 'drizzle-orm'

import { displayName, type Note } from './contract.ts'
import type { Db } from './note.ts'
import { note } from './schema.ts'

export type NoteRow = typeof note.$inferSelect

const ID_PREFIX = 'note-'

// note の CHECK が守る対応を、procedure が書く前に断るためにも持つ。
export const KINDS = {
  daily: { name: 'Daily', titled: false, deletable: false },
  essay: { name: 'Essay', titled: true, deletable: true },
  repo_note: { name: 'Repo Note', titled: true, deletable: true },
  scratch: { name: 'Scratch', titled: false, deletable: false },
} as const

export function idNumber(id: string): number {
  return Number(id.slice(ID_PREFIX.length))
}

export function noteId(number: number): string {
  return `${ID_PREFIX}${number}`
}

export function undeletedNote(db: Db, id: string): NoteRow {
  const row = db
    .select()
    .from(note)
    .where(and(eq(note.id, idNumber(id)), isNull(note.deletedAt)))
    .get()
  if (!row) throw new ORPCError('NOT_FOUND', { message: `no Note is ${id}` })
  return row
}

// 種類ごとに NOT NULL の列は note の CHECK が守る。
export function toNote(row: NoteRow): Note {
  const common = {
    id: noteId(row.id),
    date: row.date,
    content: JSON.parse(row.content),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  switch (row.kind) {
    case 'daily':
      return { kind: 'daily', ...common }
    case 'essay':
      return { kind: 'essay', title: row.title!, status: row.status!, ...common }
    case 'repo_note':
      return { kind: 'repo_note', repo: row.repo!, title: row.title!, ...common }
    case 'scratch':
      return { kind: 'scratch', repo: row.repo!, ...common }
  }
}

export function displayNameOf(row: Pick<NoteRow, 'kind' | 'date' | 'title' | 'repo'>): string {
  switch (row.kind) {
    case 'daily':
      return displayName({ kind: 'daily', date: row.date })
    case 'essay':
    case 'repo_note':
      return displayName({ kind: row.kind, title: row.title! })
    case 'scratch':
      return displayName({ kind: 'scratch', repo: row.repo! })
  }
}
