import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
