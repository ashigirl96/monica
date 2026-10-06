import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'

import type { Note } from './contract.ts'
import type { Db } from './note.ts'
import { idNumber, KINDS, toNote, undeletedNote } from './row.ts'
import { note } from './schema.ts'

export function removeNote(db: Db, id: string): void {
  const row = undeletedNote(db, id)
  const kind = KINDS[row.kind]
  if (!kind.deletable) {
    throw new ORPCError('BAD_REQUEST', { message: `a ${kind.name} cannot be deleted` })
  }
  db.update(note).set({ deletedAt: new Date() }).where(eq(note.id, row.id)).run()
}

export function restoreNote(db: Db, id: string): Note {
  const row = db
    .update(note)
    .set({ deletedAt: null })
    .where(eq(note.id, idNumber(id)))
    .returning()
    .get()
  if (!row) throw new ORPCError('NOT_FOUND', { message: `no Note is ${id}` })
  return toNote(row)
}
