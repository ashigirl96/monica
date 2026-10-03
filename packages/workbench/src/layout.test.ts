import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { cleanUp, setup } from "./testing.ts";

afterEach(cleanUp);

const size = { rows: 24, cols: 80 };

type Client = ReturnType<typeof setup>["client"];

async function checkedOrder(client: Client) {
  const { runspaces } = await client.layout.get();
  for (const siblings of [runspaces, ...runspaces.map((r) => r.tabs)]) {
    expect(siblings.map((s) => s.sortOrder)).toEqual(siblings.map((_, i) => i));
  }
  return runspaces.map((r) => ({ id: r.id, tabs: r.tabs.map((t) => t.id) }));
}

test("runspace.create opens a Runspace whose one Tab shows a new running Terminal Session", async () => {
  const { ptyd, client } = setup();

  const { runspaceId, tab } = await client.runspace.create({ cwd: "/work", rows: 30, cols: 100 });

  expect(await client.layout.get()).toEqual({
    runspaces: [{ id: runspaceId, cwd: "/work", sortOrder: 0, tabs: [tab] }],
  });
  expect(tab).toMatchObject({ cwd: "/work", sortOrder: 0 });
  expect(await ptyd.received((op) => op.op === "create")).toMatchObject({
    session_id: tab.terminalSessionId,
    cwd: "/work",
    rows: 30,
    cols: 100,
  });
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({ id: tab.terminalSessionId, status: "running", tabId: tab.id }),
  ]);
});

test("a Runspace whose Terminal Session ptyd refuses to create keeps its Tab on the failed session", async () => {
  const { ptyd, client } = setup();
  ptyd.createError = "no such directory: /nope";

  const { runspaceId, tab } = await client.runspace.create({ cwd: "/nope", rows: 24, cols: 80 });

  expect(await client.layout.get()).toEqual({
    runspaces: [{ id: runspaceId, cwd: "/nope", sortOrder: 0, tabs: [tab] }],
  });
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({
      id: tab.terminalSessionId,
      status: "failed",
      error: expect.stringContaining("no such directory: /nope"),
      endedAt: expect.any(Date),
      tabId: tab.id,
    }),
  ]);
});

test("runspace.create without a cwd opens in $HOME", async () => {
  const { ptyd, client } = setup();

  const { tab } = await client.runspace.create(size);

  expect(tab.cwd).toBe(homedir());
  expect((await client.layout.get()).runspaces[0]?.cwd).toBe(homedir());
  expect(await ptyd.received((op) => op.op === "create")).toMatchObject({ cwd: homedir() });
});

test("runspace.create appends without an index and inserts at the index given", async () => {
  const { client } = setup();

  const a = await client.runspace.create(size);
  const b = await client.runspace.create(size);
  const c = await client.runspace.create({ index: 1, ...size });

  expect(await checkedOrder(client)).toEqual([
    { id: a.runspaceId, tabs: [a.tab.id] },
    { id: c.runspaceId, tabs: [c.tab.id] },
    { id: b.runspaceId, tabs: [b.tab.id] },
  ]);
});

test("tab.open appends without an index, inserts at the index given, and opens in the Runspace's cwd", async () => {
  const { ptyd, client } = setup();
  const { runspaceId, tab: first } = await client.runspace.create({ cwd: "/work", ...size });

  const last = await client.tab.open({ runspaceId, ...size });
  const middle = await client.tab.open({ runspaceId, index: 1, cwd: "/elsewhere", ...size });

  expect(await checkedOrder(client)).toEqual([
    { id: runspaceId, tabs: [first.id, middle.id, last.id] },
  ]);
  expect([last.cwd, middle.cwd]).toEqual(["/work", "/elsewhere"]);
  expect(
    await ptyd.received((op) => op.op === "create" && op.session_id === middle.terminalSessionId),
  ).toMatchObject({ cwd: "/elsewhere" });
});

test("tab.close leaves the Terminal Session running and detached, and tab.open reattaches it", async () => {
  const { client } = setup();
  const { runspaceId, tab: kept } = await client.runspace.create(size);
  const closed = await client.tab.open({ runspaceId, ...size });

  await client.tab.close({ id: closed.id });

  expect(await checkedOrder(client)).toEqual([{ id: runspaceId, tabs: [kept.id] }]);
  expect(await client.terminalSession.list()).toContainEqual(
    expect.objectContaining({ id: closed.terminalSessionId, status: "running", tabId: null }),
  );

  const reopened = await client.tab.open({
    runspaceId,
    index: 0,
    terminalSessionId: closed.terminalSessionId,
    ...size,
  });

  expect(reopened.terminalSessionId).toBe(closed.terminalSessionId);
  expect(await checkedOrder(client)).toEqual([{ id: runspaceId, tabs: [reopened.id, kept.id] }]);
  expect(await client.terminalSession.list()).toContainEqual(
    expect.objectContaining({ id: closed.terminalSessionId, tabId: reopened.id }),
  );
});

test("tab.open reattaches only a detached Terminal Session", async () => {
  const { ptyd, client } = setup();
  const { runspaceId, tab: shown } = await client.runspace.create(size);
  const ended = await client.tab.open({ runspaceId, ...size });
  await client.tab.close({ id: ended.id });
  ptyd.exit(ended.terminalSessionId, 0);
  await ptyd.received((op) => op.op === "reap" && op.session_id === ended.terminalSessionId);

  const reattach = (terminalSessionId: string) =>
    client.tab.open({ runspaceId, terminalSessionId, ...size });

  await expect(reattach(shown.terminalSessionId)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(reattach(ended.terminalSessionId)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(reattach("ts-nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await checkedOrder(client)).toEqual([{ id: runspaceId, tabs: [shown.id] }]);
});

test("closing the last Tab removes its Runspace and renumbers the rest", async () => {
  const { client } = setup();
  const a = await client.runspace.create(size);
  const b = await client.runspace.create(size);
  const c = await client.runspace.create(size);

  await client.tab.close({ id: b.tab.id });

  expect(await checkedOrder(client)).toEqual([
    { id: a.runspaceId, tabs: [a.tab.id] },
    { id: c.runspaceId, tabs: [c.tab.id] },
  ]);
});

test("tab.move reorders Tabs within a Runspace and moves them into another at the index given", async () => {
  const { client } = setup();
  const left = await client.runspace.create(size);
  const second = await client.tab.open({ runspaceId: left.runspaceId, ...size });
  const third = await client.tab.open({ runspaceId: left.runspaceId, ...size });
  const right = await client.runspace.create(size);

  await client.tab.move({ id: third.id, runspaceId: left.runspaceId, index: 0 });

  expect(await checkedOrder(client)).toEqual([
    { id: left.runspaceId, tabs: [third.id, left.tab.id, second.id] },
    { id: right.runspaceId, tabs: [right.tab.id] },
  ]);

  await client.tab.move({ id: left.tab.id, runspaceId: right.runspaceId, index: 0 });

  expect(await checkedOrder(client)).toEqual([
    { id: left.runspaceId, tabs: [third.id, second.id] },
    { id: right.runspaceId, tabs: [left.tab.id, right.tab.id] },
  ]);
});

test("moving the last Tab out removes its Runspace and renumbers the rest", async () => {
  const { client } = setup();
  const a = await client.runspace.create(size);
  const b = await client.runspace.create(size);
  const c = await client.runspace.create(size);

  await client.tab.move({ id: a.tab.id, runspaceId: c.runspaceId, index: 1 });

  expect(await checkedOrder(client)).toEqual([
    { id: b.runspaceId, tabs: [b.tab.id] },
    { id: c.runspaceId, tabs: [c.tab.id, a.tab.id] },
  ]);
});

test("runspace.move puts the Runspace at the index given", async () => {
  const { client } = setup();
  const a = await client.runspace.create(size);
  const b = await client.runspace.create(size);
  const c = await client.runspace.create(size);

  await client.runspace.move({ id: c.runspaceId, index: 0 });

  expect((await checkedOrder(client)).map((r) => r.id)).toEqual([
    c.runspaceId,
    a.runspaceId,
    b.runspaceId,
  ]);
});

test("runspace.remove drops its Tabs and terminates their Terminal Sessions", async () => {
  const { ptyd, client } = setup();
  const kept = await client.runspace.create(size);
  const removed = await client.runspace.create(size);
  const second = await client.tab.open({ runspaceId: removed.runspaceId, ...size });

  await client.runspace.remove({ id: removed.runspaceId });

  expect(await checkedOrder(client)).toEqual([{ id: kept.runspaceId, tabs: [kept.tab.id] }]);
  for (const id of [removed.tab.terminalSessionId, second.terminalSessionId]) {
    await ptyd.received((op) => op.op === "terminate" && op.session_id === id);
  }
});

test("runspace.remove sends the terminate again to the reconnected ptyd when the connection drops after the commit", async () => {
  const { ptyd, client } = setup();
  const removed = await client.runspace.create(size);
  ptyd.dropNextTerminate = true;

  await client.runspace.remove({ id: removed.runspaceId });

  await ptyd.received(
    (op) => op.op === "terminate" && op.session_id === removed.tab.terminalSessionId,
  );
});

test("tab.respawn binds the Tab to a new Terminal Session started in its last known cwd", async () => {
  const { ptyd, client } = setup();
  const { runspaceId, tab } = await client.runspace.create({ cwd: "/work", ...size });
  await client.tab.setCwd({ id: tab.id, cwd: "/work/sub" });
  ptyd.exit(tab.terminalSessionId, 0);
  await ptyd.received((op) => op.op === "reap" && op.session_id === tab.terminalSessionId);

  const respawned = await client.tab.respawn({ id: tab.id, rows: 30, cols: 100 });

  expect(respawned).toMatchObject({ id: tab.id, cwd: "/work/sub", sortOrder: 0 });
  expect(respawned.terminalSessionId).not.toBe(tab.terminalSessionId);
  expect(
    await ptyd.received(
      (op) => op.op === "create" && op.session_id === respawned.terminalSessionId,
    ),
  ).toMatchObject({ cwd: "/work/sub", rows: 30, cols: 100 });
  expect(await client.layout.get()).toEqual({
    runspaces: [{ id: runspaceId, cwd: "/work", sortOrder: 0, tabs: [respawned] }],
  });
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({ id: respawned.terminalSessionId, status: "running", tabId: tab.id }),
  ]);
});

test("tab.respawn refuses a Tab whose Terminal Session is still live", async () => {
  const { client } = setup();
  const { tab } = await client.runspace.create(size);

  await expect(client.tab.respawn({ id: tab.id, ...size })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect((await client.layout.get()).runspaces[0]?.tabs).toEqual([tab]);
});

test("every write to the layout streams a layout signal on changes", async () => {
  const { ptyd, client } = setup();
  const subscription = new AbortController();
  const changes = await client.changes(undefined, { signal: subscription.signal });
  let signals = 0;
  const consumed = (async () => {
    for await (const change of changes) if (change.type === "layout") signals++;
  })().catch(() => {});
  const silent: string[] = [];
  async function write<T>(procedure: string, call: () => Promise<T>): Promise<T> {
    const before = signals;
    const result = await call();
    // 合図は publish から iterator を経て microtask で届くので、1 つ macrotask を回してから数える。
    await Bun.sleep(0);
    if (signals === before) silent.push(procedure);
    return result;
  }

  const { runspaceId, tab } = await write("runspace.create", () => client.runspace.create(size));
  const other = await write("tab.open", () => client.tab.open({ runspaceId, ...size }));
  await write("tab.close", () => client.tab.close({ id: other.id }));
  const reopened = await write("tab.open with a terminalSessionId", () =>
    client.tab.open({ runspaceId, terminalSessionId: other.terminalSessionId, ...size }),
  );
  await write("tab.move", () => client.tab.move({ id: reopened.id, runspaceId, index: 0 }));
  await write("tab.setCwd", () => client.tab.setCwd({ id: reopened.id, cwd: "/elsewhere" }));
  await write("runspace.move", () => client.runspace.move({ id: runspaceId, index: 0 }));
  ptyd.exit(tab.terminalSessionId, 0);
  await ptyd.received((op) => op.op === "reap" && op.session_id === tab.terminalSessionId);
  await write("tab.respawn", () => client.tab.respawn({ id: tab.id, ...size }));
  await write("runspace.remove", () => client.runspace.remove({ id: runspaceId }));
  subscription.abort();
  await consumed;

  expect(silent).toEqual([]);
});
