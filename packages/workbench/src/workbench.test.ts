import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { WorkbenchChange } from "./contract.ts";
import { startFakePtyd } from "./fake-ptyd.ts";
import type { SessionInfo } from "./ptyd.ts";
import { terminalSession } from "./schema.ts";
import { createWorkbench, type Db, migrations, router, type Workbench } from "./server.ts";
import { createTerminalSession } from "./workbench.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  // ptyd の socket の path は macOS で 104 byte を超えると bind できないので、home は短くする。
  const home = mkdtempSync(join(tmpdir(), "tania-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const ptyd = startFakePtyd(home);
  cleanups.push(() => ptyd.stop());

  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table });

  const workbench = createWorkbench({
    db,
    home,
    ptydPath: join(home, "no-ptyd"),
    notify() {},
    nameAgentSession: () => null,
  });
  cleanups.push(() => workbench.stop());
  const client = createRouterClient(router, { context: { db, workbench } });
  return { home, ptyd, db, workbench, client };
}

function heldByPtyd(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: id,
    running: true,
    attached: false,
    pid: 4242,
    exit_code: null,
    cwd: "/tmp/somewhere",
    rows: 24,
    cols: 80,
    ...overrides,
  };
}

type Status = (typeof terminalSession.$inferSelect)["status"];

function seedRow(db: Db, id: string, status: Status) {
  db.insert(terminalSession)
    .values({
      id,
      cwd: "/tmp/somewhere",
      shell: "/bin/zsh",
      status,
      pid: 1,
      createdAt: new Date(0),
    })
    .run();
}

function rowOf(db: Db, id: string) {
  return db.select().from(terminalSession).where(eq(terminalSession.id, id)).get();
}

test("a live row ptyd no longer holds turns lost", async () => {
  const { db, workbench, client } = setup();
  seedRow(db, "ts-gone", "running");

  await workbench.start();

  expect(rowOf(db, "ts-gone")).toMatchObject({ status: "lost", endedAt: expect.any(Date) });
  expect(await client.terminalSession.list()).toEqual([]);
});

test("a live row whose shell died meanwhile turns exited with the code, then its tombstone is reaped", async () => {
  const { ptyd, db, workbench, client } = setup();
  seedRow(db, "ts-died", "running");
  ptyd.sessions.push(heldByPtyd("ts-died", { running: false, pid: null, exit_code: 3 }));

  await workbench.start();

  expect(rowOf(db, "ts-died")).toMatchObject({ status: "exited", exitCode: 3 });
  expect(await client.terminalSession.list()).toEqual([]);
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-died");
});

test("a live row ptyd still runs stays listed with ptyd's pid", async () => {
  const { ptyd, db, workbench, client } = setup();
  seedRow(db, "ts-alive", "running");
  ptyd.sessions.push(heldByPtyd("ts-alive", { pid: 999 }));

  await workbench.start();

  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({ id: "ts-alive", status: "running", pid: 999 }),
  ]);
});

test("an ended row stays ended; ptyd's session under its id is terminated or reaped", async () => {
  const { ptyd, db, workbench, client } = setup();
  seedRow(db, "ts-exited", "exited");
  seedRow(db, "ts-lost", "lost");
  seedRow(db, "ts-failed", "failed");
  ptyd.sessions.push(heldByPtyd("ts-exited"));
  ptyd.sessions.push(heldByPtyd("ts-lost", { running: false, pid: null, exit_code: 0 }));

  await workbench.start();

  expect(rowOf(db, "ts-exited")?.status).toBe("exited");
  expect(rowOf(db, "ts-lost")?.status).toBe("lost");
  expect(rowOf(db, "ts-failed")?.status).toBe("failed");
  expect(await client.terminalSession.list()).toEqual([]);
  await ptyd.received((op) => op.op === "terminate" && op.session_id === "ts-exited");
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-lost");
});

test("a tombstone only ptyd knows is reaped without a row", async () => {
  const { ptyd, db, workbench } = setup();
  ptyd.sessions.push(heldByPtyd("ts-stray", { running: false, pid: null, exit_code: 0 }));

  await workbench.start();

  expect(rowOf(db, "ts-stray")).toBeUndefined();
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-stray");
});

test("an Exit from ptyd turns the row exited with the code and reaps the tombstone", async () => {
  const { ptyd, db, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-a"));
  await workbench.start();

  ptyd.exit("ts-a", 130);
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-a");

  expect(rowOf(db, "ts-a")).toMatchObject({ status: "exited", exitCode: 130 });
  expect(await client.terminalSession.list()).toEqual([]);
});

test("a new Terminal Session runs in ptyd under a ts-<uuidv7> id with the shell fixed at startup", async () => {
  const shell = process.env.SHELL;
  cleanups.push(() => {
    process.env.SHELL = shell;
  });
  process.env.SHELL = "/bin/startup-shell";
  const { ptyd, workbench, client } = setup();
  process.env.SHELL = "/bin/later-shell";
  await workbench.start();

  const created = await createTerminalSession(workbench, { cwd: "/work", rows: 30, cols: 100 });

  expect(created.id).toMatch(/^ts-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(await ptyd.received((op) => op.op === "create")).toMatchObject({
    session_id: created.id,
    cwd: "/work",
    shell: "/bin/startup-shell",
    rows: 30,
    cols: 100,
  });
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({
      id: created.id,
      status: "running",
      pid: 1000,
      shell: "/bin/startup-shell",
    }),
  ]);
});

test("a shell that dies before ptyd answers Created stays exited", async () => {
  const { ptyd, db, workbench } = setup();
  ptyd.beforeCreated = (op) => [{ type: "exit", session_id: op.session_id, exit_code: 127 }];
  await workbench.start();

  const created = await createTerminalSession(workbench, { cwd: "/work", rows: 24, cols: 80 });

  expect(created).toMatchObject({ status: "exited", exitCode: 127 });
  expect(rowOf(db, created.id)?.status).toBe("exited");
});

test("a Terminal Session ptyd refuses to create turns failed with the reason", async () => {
  const { ptyd, workbench, client } = setup();
  ptyd.createError = "no such directory: /nope";
  await workbench.start();

  const created = await createTerminalSession(workbench, { cwd: "/nope", rows: 24, cols: 80 });

  expect(created).toMatchObject({ status: "failed", endedAt: expect.any(Date) });
  expect(created.error).toContain("no such directory: /nope");
  expect(await client.terminalSession.list()).toEqual([]);
});

function nextChange(workbench: Workbench, type: WorkbenchChange["type"]): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = workbench.events.subscribe("change", (change) => {
      if (change.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

test("while ptyd is gone the Backend keeps retrying, then reconciles against the new ptyd", async () => {
  const { home, ptyd, db, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-a"));
  await workbench.start();

  const reconciled = nextChange(workbench, "reconciled");
  ptyd.stop();
  await Bun.sleep(50);
  const revived = startFakePtyd(home);
  cleanups.push(() => revived.stop());
  await reconciled;

  expect(rowOf(db, "ts-a")?.status).toBe("lost");
  expect(await client.terminalSession.list()).toEqual([]);
});

test("terminate asks ptyd to kill the session, and the row turns exited on ptyd's Exit", async () => {
  const { ptyd, db, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-a"));
  await workbench.start();

  await client.terminalSession.terminate({ id: "ts-a" });
  await ptyd.received((op) => op.op === "terminate" && op.session_id === "ts-a");
  expect(rowOf(db, "ts-a")?.status).toBe("running");

  ptyd.exit("ts-a", null);
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-a");
  expect(rowOf(db, "ts-a")?.status).toBe("exited");
});

test("terminate refuses an id the books do not know", async () => {
  const { workbench, client } = setup();
  await workbench.start();

  await expect(client.terminalSession.terminate({ id: "ts-nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("changes streams a signal naming the Terminal Session that changed", async () => {
  const { ptyd, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-a"));
  await workbench.start();

  const changes = await client.changes();
  const next = changes.next();
  ptyd.exit("ts-a", 0);

  expect((await next).value).toEqual({ type: "terminalSession", id: "ts-a" });
  await changes.return?.();
});

test("an Exit that arrives while the reconcile waits for List still ends the adopted row", async () => {
  const { ptyd, db, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-orphan"));
  ptyd.beforeList = () => [{ type: "exit", session_id: "ts-orphan", exit_code: 0 }];

  await workbench.start();
  await ptyd.received((op) => op.op === "reap" && op.session_id === "ts-orphan");

  expect(rowOf(db, "ts-orphan")).toMatchObject({ status: "exited", exitCode: 0 });
  expect(await client.terminalSession.list()).toEqual([]);
});

test("a ptyd that drops the connection mid-handshake leaves a single connection after the retry", async () => {
  const { ptyd, workbench } = setup();
  ptyd.dropNextList = true;

  await workbench.start();
  await Bun.sleep(100);

  expect(ptyd.connections).toBe(1);
});

test("a cwd whose multibyte character straddles two socket chunks is read intact", async () => {
  const { ptyd, db, workbench } = setup();
  ptyd.sessions.push(heldByPtyd("ts-a", { cwd: "/work/日本語" }));
  ptyd.splitListMidCharacter = true;

  await workbench.start();

  expect(rowOf(db, "ts-a")?.cwd).toBe("/work/日本語");
});

test("a live session only ptyd knows is adopted without a shell and listed", async () => {
  const { ptyd, workbench, client } = setup();
  ptyd.sessions.push(heldByPtyd("ts-orphan", { pid: 777, cwd: "/work/repo" }));

  await workbench.start();

  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({
      id: "ts-orphan",
      cwd: "/work/repo",
      shell: "",
      status: "running",
      pid: 777,
    }),
  ]);
});
