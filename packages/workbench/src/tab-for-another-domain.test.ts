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

test("writeTerminalSession fails when ptyd refuses the write", async () => {
  const { ptyd, workbench } = setup();
  ptyd.writeError = "no session ts-gone";

  await expect(workbench.writeTerminalSession("ts-gone", "claude\r")).rejects.toThrow(
    "no session ts-gone",
  );
});
