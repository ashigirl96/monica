import { ORPCError } from '@orpc/server'
import { desc, isNull } from 'drizzle-orm'

import { type Block, blockById } from './body/index.ts'
import { type NoteMentionCandidate, NoteIdSchema } from './contract.ts'
import type { Db } from './db.ts'
import { displayNameOf, noteId, type NoteRow, undeletedNote } from './row.ts'
import { note } from './schema.ts'

const MAX_CANDIDATES = 20

// 表示名は列に無い導出値なので、SQL ではなく displayName で絞る。
export function searchNoteMentions(db: Db, q: string): NoteMentionCandidate[] {
  const query = q.trim().toLowerCase()
  const rows = db
    .select({
      id: note.id,
      kind: note.kind,
      date: note.date,
      title: note.title,
      repo: note.repo,
      preview: note.preview,
    })
    .from(note)
    .where(isNull(note.deletedAt))
    .orderBy(desc(note.updatedAt), desc(note.id))
    .all()
  const found: NoteMentionCandidate[] = []
  for (const row of rows) {
    const name = displayNameOf(row)
    const fields = [row.title, name, row.preview, row.repo]
    if (!fields.some((field) => field?.toLowerCase().includes(query))) continue
    found.push({ id: noteId(row.id), displayName: name, preview: row.preview })
    if (found.length === MAX_CANDIDATES) break
  }
  return found
}

export function resolveNoteMention(db: Db, id: string): { displayName: string } {
  return { displayName: displayNameOf(referencedNote(db, id)) }
}

export function noteBlock(db: Db, id: string, blockId: string): Block {
  const found = blockById(JSON.parse(referencedNote(db, id).content), blockId)
  if (found === null) throw new ORPCError('NOT_FOUND', { message: `${id} has no block ${blockId}` })
  return found
}

function referencedNote(db: Db, id: string): NoteRow {
  if (!NoteIdSchema.safeParse(id).success) {
    throw new ORPCError('NOT_FOUND', { message: `no Note is ${id}` })
  }
  return undeletedNote(db, id)
}
