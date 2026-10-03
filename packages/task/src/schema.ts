import {
  type AnySQLiteColumn,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

// 同じ issue かは GitHub の node ID で決め、repo は改名に追従する。node ID で見つからなければ小文字の repo と番号で照らす。
export const issue = sqliteTable(
  "issue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: text("node_id").unique(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state", { enum: ["open", "closed"] }).notNull(),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
    parentId: integer("parent_id").references((): AnySQLiteColumn => issue.id),
    syncedAt: timestamp("synced_at").notNull(),
  },
  (t) => [uniqueIndex("issue_repo_number").on(t.repo, t.number)],
);

export const issueBlocker = sqliteTable(
  "issue_blocker",
  {
    issueId: integer("issue_id")
      .notNull()
      .references(() => issue.id),
    blockerId: integer("blocker_id")
      .notNull()
      .references(() => issue.id),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.blockerId] })],
);

export const task = sqliteTable("task", {
  issueId: integer("issue_id")
    .primaryKey()
    .references(() => issue.id),
  trackedAt: timestamp("tracked_at").notNull(),
  closedAt: timestamp("closed_at"),
});
