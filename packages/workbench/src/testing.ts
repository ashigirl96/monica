import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { startFakePtyd } from "./fake-ptyd.ts";
import { createWorkbench, migrations, router } from "./server.ts";

const cleanups: (() => void)[] = [];

export function onCleanup(cleanup: () => void) {
  cleanups.push(cleanup);
}

export function cleanUp() {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

export function setup() {
  // ptyd の socket の path は macOS で 104 byte を超えると bind できないので、home は短くする。
  const home = mkdtempSync(join(tmpdir(), "tania-"));
  onCleanup(() => rmSync(home, { recursive: true, force: true }));
  const ptyd = startFakePtyd(home);
  onCleanup(() => ptyd.stop());

  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table });

  function boot() {
    const workbench = createWorkbench({
      db,
      home,
      ptydPath: join(home, "no-ptyd"),
      notify() {},
      nameAgentSession: () => null,
    });
    onCleanup(() => workbench.stop());
    const client = createRouterClient(router, { context: { db, workbench } });
    return { workbench, client };
  }

  const booted = boot();
  function restartBackend() {
    booted.workbench.stop();
    return boot();
  }
  return { home, ptyd, db, ...booted, restartBackend };
}
