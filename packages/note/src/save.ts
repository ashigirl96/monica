import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'
import { eq } from 'drizzle-orm'

import { preview } from './body/index.ts'
import type { Doc, EssayStatus, Note, saveErrors } from './contract.ts'
import type { Db } from './db.ts'
import { KINDS, toNote, undeletedNote } from './row.ts'
import { note } from './schema.ts'

export function saveNote(
  db: Db,
  input: { id: string; content: Doc; title?: string; expectedUpdatedAt: Date },
  errors: ORPCErrorConstructorMap<typeof saveErrors>,
): { updatedAt: Date } {
  const row = undeletedNote(db, input.id)
  const kind = KINDS[row.kind]
  if (input.title !== undefined && !kind.titled) {
    throw new ORPCError('BAD_REQUEST', { message: `a ${kind.name} has no title` })
  }
  if (row.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw errors.CONFLICT()
  const updatedAt = nextUpdatedAt(row.updatedAt)
  db.update(note)
    .set({
      content: JSON.stringify(input.content),
      preview: preview(input.content),
      title: input.title,
      updatedAt,
    })
    .where(eq(note.id, row.id))
    .run()
  return { updatedAt }
}

export function setEssayStatus(db: Db, id: string, status: EssayStatus): Note {
  const row = undeletedNote(db, id)
  if (row.kind !== 'essay') {
    throw new ORPCError('BAD_REQUEST', { message: `a ${KINDS[row.kind].name} has no status` })
  }
  if (row.status === status) return toNote(row)
  const updated = db
    .update(note)
    .set({ status, updatedAt: nextUpdatedAt(row.updatedAt) })
    .where(eq(note.id, row.id))
    .returning()
    .get()
  return toNote(updated!)
}

// 同じ ms のうちに 2 度書いても updatedAt が進まないと、古い版からの保存が CONFLICT にならない。
function nextUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}
