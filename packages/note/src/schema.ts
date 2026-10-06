import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

// id は外に `note-N` で出す。AUTOINCREMENT なので消した番号も再利用しない（ADR-0019）。
export const note = sqliteTable(
  'note',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['daily', 'essay', 'repo_note', 'scratch'] }).notNull(),
    repo: text('repo'),
    title: text('title'),
    status: text('status', { enum: ['writing', 'finished'] }),
    date: text('date').notNull(),
    content: text('content').notNull(),
    preview: text('preview'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('note_daily_per_date_idx')
      .on(t.date)
      .where(sql`kind = 'daily'`),
    // GitHub の repo 名は大文字と小文字を区別しない。
    uniqueIndex('note_scratch_per_repo_idx')
      .on(sql`lower(repo)`)
      .where(sql`kind = 'scratch'`),
    check('note_kind', sql`kind IN ('daily', 'essay', 'repo_note', 'scratch')`),
    check('note_title', sql`(kind IN ('essay', 'repo_note')) = (title IS NOT NULL)`),
    check(
      'note_status',
      sql`(kind = 'essay') = (status IS NOT NULL) AND (status IS NULL OR status IN ('writing', 'finished'))`,
    ),
    check('note_repo', sql`(kind IN ('repo_note', 'scratch')) = (repo IS NOT NULL)`),
    check('note_deleted_at', sql`deleted_at IS NULL OR kind IN ('essay', 'repo_note')`),
  ],
)
