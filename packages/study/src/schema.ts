import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

export const study = sqliteTable('study', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').notNull(),
  lastActiveAt: timestamp('last_active_at').notNull(),
  playgroundRemovedAt: timestamp('playground_removed_at'),
})

export const studyConversation = sqliteTable(
  'study_conversation',
  {
    id: text('id').primaryKey(),
    studyId: text('study_id')
      .notNull()
      .references(() => study.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
    sessionId: text('session_id'),
  },
  (t) => [
    uniqueIndex('study_conversation_ongoing_idx')
      .on(t.studyId)
      .where(sql`ended_at IS NULL`),
  ],
)

// kind の並びは CHECK にしない。kind を足すたびに table を作り直さずに済むため。
export const studyMessage = sqliteTable(
  'study_message',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => studyConversation.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull(),
    kind: text('kind', { enum: ['user', 'tutor', 'tool', 'tutor_switch'] }).notNull(),
    text: text('text').notNull(),
    tool: text('tool'),
  },
  () => [check('study_message_tool', sql`(kind = 'tool') = (tool IS NOT NULL)`)],
)
