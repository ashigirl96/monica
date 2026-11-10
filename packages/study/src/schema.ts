import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

export const study = sqliteTable('study', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').notNull(),
  lastActiveAt: timestamp('last_active_at').notNull(),
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
    summary: text('summary'),
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
    kind: text('kind', {
      enum: ['user', 'tutor', 'tool', 'tutor_switch', 'permission', 'reflection'],
    }).notNull(),
    text: text('text').notNull(),
    tool: text('tool'),
    reason: text('reason'),
    permissionState: text('permission_state', { enum: ['pending', 'allowed', 'denied'] }),
  },
  () => [
    check('study_message_tool', sql`(kind = 'tool') = (tool IS NOT NULL)`),
    check(
      'study_message_permission_state',
      sql`permission_state IS NULL OR permission_state IN ('pending', 'allowed', 'denied')`,
    ),
    check('study_message_permission', sql`(kind = 'permission') = (permission_state IS NOT NULL)`),
  ],
)

// repo は紐付けた時の綴りのまま持つ。GitHub の repo 名は大文字と小文字を区別しない。
export const studyRepo = sqliteTable(
  'study_repo',
  {
    studyId: text('study_id')
      .notNull()
      .references(() => study.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('study_repo_per_study_idx').on(t.studyId, sql`lower(repo)`),
    index('study_repo_repo_idx').on(sql`lower(repo)`),
  ],
)
