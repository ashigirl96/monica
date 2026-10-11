import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const CALLERS = ['webview', 'cli', 'extension', 'notes'] as const

// 行は Feature × Caller × 日数に収まるので、消さずに残す（ADR-0037）。
export const usage = sqliteTable(
  'usage',
  {
    feature: text('feature').notNull(),
    caller: text('caller', { enum: CALLERS }).notNull(),
    // Backend の手元の暦日（YYYY-MM-DD）。
    date: text('date').notNull(),
    ok: integer('ok').notNull(),
    failed: integer('failed').notNull(),
  },
  (t) => [primaryKey({ columns: [t.feature, t.caller, t.date] })],
)
