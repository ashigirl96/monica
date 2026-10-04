import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import { createWorkbench, migrations as workbenchMigrations } from "@tania/workbench/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fakeGhq } from "./fake-ghq.ts";
import { startFakeGitHub } from "./fake-github.ts";
import { createTask, migrations, router } from "./server.ts";

const cleanups: (() => void)[] = [];

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

export function setup() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite);
  for (const m of [workbenchMigrations, migrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table });
  }
  // Task は ptyd を使わないので、Workbench は start() せずに渡す。
  const workbench = createWorkbench({
    db,
    home: "/nonexistent",
    ptydPath: "/nonexistent",
    notify() {},
    nameAgentSession: () => null,
  });
  const github = startFakeGitHub();
  cleanups.push(() => github.stop());
  const scratch = mkdtempSync(join(tmpdir(), "tania-task-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, "home");
  mkdirSync(home);
  const ghq = fakeGhq(scratch);

  function boot() {
    const task = createTask({ db, workbench, github: github.client, home, ghq: ghq.client });
    cleanups.push(() => task.stop());
    const client = createRouterClient(router, { context: { db, task } });
    return { task, client };
  }

  const booted = boot();
  function restartTask() {
    booted.task.stop();
    return boot();
  }
  return { db, workbench, github, ghq, home, ...booted, restartTask };
}
