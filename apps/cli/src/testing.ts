import { Database } from "bun:sqlite";
import { createTask, migrations as taskMigrations, router as taskRouter } from "@tania/task/server";
import { terminalSession } from "@tania/workbench/schema";
import {
  createWorkbench,
  migrations as workbenchMigrations,
  router as workbenchRouter,
} from "@tania/workbench/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Client } from "./backend.ts";
import { runCli } from "./program.ts";

export function inMemoryBackend() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite);
  for (const m of [workbenchMigrations, taskMigrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table });
  }
  const workbench = createWorkbench({
    db,
    home: "/nonexistent",
    ptydPath: "/nonexistent",
    notify() {},
    nameAgentSession: () => null,
  });
  const task = createTask({ db, workbench });
  db.insert(terminalSession)
    .values({
      id: "ts-a",
      cwd: "/work",
      shell: "/bin/zsh",
      status: "running",
      pid: 42,
      createdAt: new Date(0),
    })
    .run();
  return {
    sqlite,
    router: { workbench: workbenchRouter, task: taskRouter },
    context: { db, workbench, task },
  };
}

export async function tania(argv: string[], connect: () => Client | null) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    connect,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}
