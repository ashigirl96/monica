import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

// ユーザーの Job だけを持つ。system の Job は Backend が createJobLedger に渡す。
export const job = sqliteTable('job', {
  name: text('name').primaryKey(),
  schedule: text('schedule').notNull(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  timeoutMs: integer('timeout_ms').notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  addedAt: timestamp('added_at').notNull(),
})

// result が無い行は走っている回。
export const jobExecution = sqliteTable(
  'job_execution',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobName: text('job_name').notNull(),
    scheduledAt: timestamp('scheduled_at').notNull(),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
    result: text('result', { enum: ['succeeded', 'failed', 'timed_out', 'interrupted'] }),
    exitCode: integer('exit_code'),
    error: text('error'),
    logPath: text('log_path'),
  },
  (t) => [index('job_execution_job_name').on(t.jobName, t.id)],
)
