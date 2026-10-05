import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import { os } from "@orpc/server";
import {
  createTask,
  type Ghq,
  migrations as taskMigrations,
  router as taskRouter,
} from "@tania/task/server";
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

// CI に ghq は無く、手元では本物の repo を clone してしまう。
const noGhq: Ghq = {
  root: () => Promise.reject(new Error("ghq root failed: no ghq in the CLI tests")),
  get: () => Promise.reject(new Error("ghq get failed: no ghq in the CLI tests")),
};

export function inMemoryBackend({ home = "/nonexistent", ghq = noGhq } = {}) {
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
  // ptyd が無いので、Workbench が ptyd に送る口は何もせずに返す。
  spyOn(workbench, "ready").mockResolvedValue();
  spyOn(workbench, "startTerminalSession").mockResolvedValue();
  spyOn(workbench, "writeTerminalSession").mockResolvedValue();
  spyOn(workbench, "terminateTerminalSessions").mockResolvedValue();
  // CLI のテストは GitHub に届かせない。
  const task = createTask({
    db,
    workbench,
    home,
    ghq,
    github: {
      url: "http://127.0.0.1:9/graphql",
      token: () => Promise.reject(new Error("`gh auth token` failed: not logged in")),
    },
  });
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
  const context = { db, workbench, task };
  return {
    sqlite,
    db,
    router: os.$context<typeof context>().router({ workbench: workbenchRouter, task: taskRouter }),
    context,
  };
}

export async function tania(
  argv: string[],
  connect: () => Client | null,
  { terminalSessionId }: { terminalSessionId?: string } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    connect,
    terminalSessionId,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}
