import { afterEach, expect, test } from "bun:test";
import type { WorkbenchChange } from "./contract.ts";
import { cleanUp, setup } from "./testing.ts";

afterEach(cleanUp);

const size = { rows: 24, cols: 80 };

function setupWithOwned() {
  const booted = setup();
  const { db, workbench } = booted;
  const owned = db.transaction((tx) => workbench.createRunspace(tx, { cwd: "/work/bench" }));
  return { ...booted, owned };
}

test("openTab opens a Tab at the end of the Runspace on a starting Terminal Session, in the Runspace's cwd unless given one", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const first = await client.tab.open({ runspaceId: owned, ...size });
  await workbench.ready();

  const inBench = db.transaction((tx) => workbench.openTab(tx, { runspaceId: owned }));
  const elsewhere = db.transaction((tx) =>
    workbench.openTab(tx, { runspaceId: owned, cwd: "/work/bench/app" }),
  );

  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      tabs: [
        { id: first.id },
        { id: inBench.tabId, cwd: "/work/bench", terminalSessionId: inBench.terminalSessionId },
        { id: elsewhere.tabId, cwd: "/work/bench/app" },
      ],
    },
  ]);
  expect(
    (await client.terminalSession.list()).find((s) => s.id === elsewhere.terminalSessionId),
  ).toMatchObject({ cwd: "/work/bench/app", status: "starting" });
});

test("openTab signals the layout, so the webview reads a Tab another domain opened", () => {
  const { db, workbench, owned } = setupWithOwned();
  const changes: WorkbenchChange[] = [];
  workbench.events.subscribe("change", (change) => changes.push(change));

  db.transaction((tx) => workbench.openTab(tx, { runspaceId: owned }));

  expect(changes).toEqual([{ type: "layout" }]);
});

test("a Tab opened after ready starts its shell and is typed into without being attached", async () => {
  const { ptyd, db, workbench, client, owned } = setupWithOwned();
  await workbench.ready();
  const { terminalSessionId } = db.transaction((tx) =>
    workbench.openTab(tx, { runspaceId: owned }),
  );

  await workbench.startTerminalSession(terminalSessionId, size);
  await workbench.writeTerminalSession(terminalSessionId, "claude\r");

  expect(await ptyd.received((op) => op.op === "create")).toMatchObject({
    session_id: terminalSessionId,
    cwd: "/work/bench",
    ...size,
  });
  const written = await ptyd.received((op) => op.op === "write");
  expect(written).toMatchObject({ session_id: terminalSessionId });
  expect(Buffer.from((written as { data: string }).data, "base64").toString()).toBe("claude\r");
  expect(await client.terminalSession.list()).toMatchObject([
    { id: terminalSessionId, status: "running" },
  ]);
});

test("moveTab moves a Tab to the end of another Runspace, drops its pin, removes the Runspace it emptied, and signals the layout", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const inBench = await client.tab.open({ runspaceId: owned, ...size });
  const elsewhere = await client.runspace.create({ cwd: "/work", ...size });
  await client.tab.pin({ id: elsewhere.tab.id });
  const changes: WorkbenchChange[] = [];
  workbench.events.subscribe("change", (change) => changes.push(change));

  db.transaction((tx) => workbench.moveTab(tx, elsewhere.tab.id, owned));

  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      tabs: [
        { id: inBench.id, sortOrder: 0 },
        { id: elsewhere.tab.id, sortOrder: 1, pinned: false },
      ],
    },
  ]);
  expect(changes).toEqual([{ type: "layout" }]);
});

test("removeRunspace removes the owned Runspace with all its Tabs, pinned ones too, returns their Terminal Sessions, and signals the layout", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const plain = await client.runspace.create(size);
  const first = await client.tab.open({ runspaceId: owned, ...size });
  const pinned = await client.tab.open({ runspaceId: owned, ...size });
  await client.tab.pin({ id: pinned.id });
  const changes: WorkbenchChange[] = [];
  workbench.events.subscribe("change", (change) => changes.push(change));

  const removed = db.transaction((tx) => workbench.removeRunspace(tx, owned));

  expect(removed).toEqual([first.terminalSessionId, pinned.terminalSessionId]);
  expect((await client.layout.get()).runspaces).toMatchObject([
    { id: plain.runspaceId, sortOrder: 0 },
  ]);
  expect(changes).toEqual([{ type: "layout" }]);
});

test("removeRunspace keeps the spared Tab, pinned or not, in the Runspace it no longer owns, and returns the other Tabs' Terminal Sessions", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const other = await client.tab.open({ runspaceId: owned, ...size });
  const spared = await client.tab.open({ runspaceId: owned, ...size });
  await client.tab.pin({ id: spared.id });

  const removed = db.transaction((tx) =>
    workbench.removeRunspace(tx, owned, { spare: [spared.terminalSessionId] }),
  );

  expect(removed).toEqual([other.terminalSessionId]);
  expect((await client.layout.get()).runspaces).toEqual([
    {
      id: owned,
      cwd: "/work/bench",
      sortOrder: 0,
      owned: false,
      tabs: [{ ...spared, sortOrder: 0, pinned: true }],
    },
  ]);
});

test("removeRunspace keeps every spared Tab in their order", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const first = await client.tab.open({ runspaceId: owned, ...size });
  const other = await client.tab.open({ runspaceId: owned, ...size });
  const last = await client.tab.open({ runspaceId: owned, ...size });

  const removed = db.transaction((tx) =>
    workbench.removeRunspace(tx, owned, {
      spare: [last.terminalSessionId, first.terminalSessionId],
    }),
  );

  expect(removed).toEqual([other.terminalSessionId]);
  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      owned: false,
      tabs: [
        { id: first.id, sortOrder: 0 },
        { id: last.id, sortOrder: 1 },
      ],
    },
  ]);
});

test("the Runspace a spared Tab stays in goes away with its last Tab, like any other", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const spared = await client.tab.open({ runspaceId: owned, ...size });
  db.transaction((tx) =>
    workbench.removeRunspace(tx, owned, { spare: [spared.terminalSessionId] }),
  );

  await client.tab.close({ id: spared.id });

  expect((await client.layout.get()).runspaces).toEqual([]);
});

test("removeRunspace removes the whole Runspace when the spared Terminal Session is in none of its Tabs", async () => {
  const { db, workbench, client, owned } = setupWithOwned();
  const inBench = await client.tab.open({ runspaceId: owned, ...size });
  const elsewhere = await client.runspace.create(size);

  const removed = db.transaction((tx) =>
    workbench.removeRunspace(tx, owned, { spare: [elsewhere.tab.terminalSessionId] }),
  );

  expect(removed).toEqual([inBench.terminalSessionId]);
  expect((await client.layout.get()).runspaces.map((r) => r.id)).toEqual([elsewhere.runspaceId]);
});

test("terminateTerminalSessions asks ptyd to terminate each Terminal Session", async () => {
  const { ptyd, workbench } = setup();

  await workbench.terminateTerminalSessions(["ts-a", "ts-b"]);

  expect(ptyd.receivedAll((op) => op.op === "terminate")).toEqual([
    { op: "terminate", session_id: "ts-a" },
    { op: "terminate", session_id: "ts-b" },
  ]);
});

test("writeTerminalSession fails when ptyd refuses the write", async () => {
  const { ptyd, workbench } = setup();
  ptyd.writeError = "no session ts-gone";

  await expect(workbench.writeTerminalSession("ts-gone", "claude\r")).rejects.toThrow(
    "no session ts-gone",
  );
});
