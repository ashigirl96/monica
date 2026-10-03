import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const terminalSession = sqliteTable("terminal_session", {
  id: text("id").primaryKey(),
  cwd: text("cwd").notNull(),
  shell: text("shell").notNull(),
  status: text("status", { enum: ["starting", "running", "exited", "lost", "failed"] }).notNull(),
  pid: integer("pid"),
  exitCode: integer("exit_code"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
});

// sort_order は兄弟を 1 行ずつ UPDATE して振り直すので、途中で同値ができる。unique にしない。
export const runspace = sqliteTable("runspace", {
  id: text("id").primaryKey(),
  cwd: text("cwd").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const tab = sqliteTable(
  "tab",
  {
    id: text("id").primaryKey(),
    runspaceId: text("runspace_id")
      .notNull()
      .references(() => runspace.id, { onDelete: "cascade" }),
    cwd: text("cwd").notNull(),
    sortOrder: integer("sort_order").notNull(),
    terminalSessionId: text("terminal_session_id")
      .notNull()
      .unique()
      .references(() => terminalSession.id),
  },
  (t) => [index("tab_runspace_idx").on(t.runspaceId)],
);
