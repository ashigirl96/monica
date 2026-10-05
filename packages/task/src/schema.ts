import { agentSession, runspace } from '@tania/workbench/schema'
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

// 同じ issue かは GitHub の node ID で決め、repo は改名に追従する。node ID で見つからなければ小文字の repo と番号で照らす。
export const issue = sqliteTable(
  'issue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nodeId: text('node_id').unique(),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    state: text('state', { enum: ['open', 'closed'] }).notNull(),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default([]),
    parentId: integer('parent_id').references((): AnySQLiteColumn => issue.id),
    syncedAt: timestamp('synced_at').notNull(),
  },
  (t) => [uniqueIndex('issue_repo_number').on(t.repo, t.number)],
)

export const issueBlocker = sqliteTable(
  'issue_blocker',
  {
    issueId: integer('issue_id')
      .notNull()
      .references(() => issue.id),
    blockerId: integer('blocker_id')
      .notNull()
      .references(() => issue.id),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.blockerId] })],
)

export const task = sqliteTable('task', {
  issueId: integer('issue_id')
    .primaryKey()
    .references(() => issue.id),
  trackedAt: timestamp('tracked_at').notNull(),
  closedAt: timestamp('closed_at'),
})

// 行は履歴として消さない。終わりは Agent Session の終了から導くので持たない。
export const run = sqliteTable(
  'run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskIssueId: integer('task_issue_id')
      .notNull()
      .references(() => task.issueId),
    agentSessionId: text('agent_session_id')
      .notNull()
      .unique()
      .references(() => agentSession.sessionId),
    origin: text('origin', { enum: ['started', 'attached'] }).notNull(),
    startedAt: timestamp('started_at').notNull(),
  },
  (t) => [index('run_task').on(t.taskIssueId)],
)

// close で行を消し、reopen で作り直す。cwd は作った時に決め、その後は変えない。
export const bench = sqliteTable('bench', {
  taskIssueId: integer('task_issue_id')
    .primaryKey()
    .references(() => task.issueId),
  runspaceId: text('runspace_id')
    .notNull()
    .unique()
    .references(() => runspace.id),
  cwd: text('cwd').notNull(),
  mode: text('mode', { enum: ['worktree', 'in_place'] }).notNull(),
  branch: text('branch'),
  setupState: text('setup_state', { enum: ['preparing', 'ready', 'failed'] }).notNull(),
  setupError: text('setup_error'),
  createdAt: timestamp('created_at').notNull(),
  preparedAt: timestamp('prepared_at'),
})
