import { afterEach, expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

// Shell の command は Tauri の外では呼べないので、呼ばれた command だけを記録する。
const shellCalls: { command: string; args: Record<string, unknown> }[] = [];
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (command: string, args: Record<string, unknown>) => {
    shellCalls.push({ command, args });
  },
}));

const { createStore } = await import("jotai");
const { cleanUp, setup } = await import("../testing.ts");
const {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  closeTerminalTabAtom,
  createRunspaceAtom,
  createTerminalTabAtom,
  deadTabsAtom,
  terminateTerminalSessionAtom,
  moveTabToRunspaceAtom,
  reattachTerminalSessionAtom,
  reloadAtom,
  reorderRunspacesAtom,
  reorderTabsAtom,
  startNewShellForTabAtom,
  tabExitedAtom,
  terminateTabTerminalSessionAtom,
  updateTabCwdAtom,
  updateTabTitleAtom,
  workbenchClientAtom,
} = await import("./store.ts");
const { detachedTerminalSessionsAtom, terminalSessionStatusAtom } =
  await import("./terminal-sessions.ts");
const { getTabConnection, openTabConnection } = await import("./terminal-connections.ts");

const size = { rows: 24, cols: 80 };

afterEach(() => {
  cleanUp();
  shellCalls.length = 0;
});

function bench() {
  const backend = setup();
  const store = createStore();
  store.set(workbenchClientAtom, () => backend.client);
  return { ...backend, store };
}

test("an empty layout gets one Runspace, even when two reloads race", async () => {
  const { client, store } = bench();

  await Promise.all([store.set(reloadAtom), store.set(reloadAtom)]);

  expect((await client.layout.get()).runspaces).toHaveLength(1);
});

test("a new Runspace goes right after the active one, in its active Tab's cwd, and becomes active", async () => {
  const { client, store } = bench();
  const a = await client.runspace.create({ cwd: "/a", ...size });
  const b = await client.runspace.create({ cwd: "/b", ...size });
  await store.set(reloadAtom);
  store.set(activateRunspaceAtom, a.runspaceId);

  await store.set(createRunspaceAtom);

  const { runspaces } = await client.layout.get();
  expect(runspaces.map((r) => r.id)).toEqual([a.runspaceId, expect.any(String), b.runspaceId]);
  expect(runspaces[1]?.cwd).toBe("/a");
  expect(store.get(activeRunspaceAtom)?.id).toBe(runspaces[1]!.id);
});

test("a new Tab goes right after the active one, in its cwd, and becomes active", async () => {
  const { client, store } = bench();
  const { runspaceId, tab: first } = await client.runspace.create({ cwd: "/a", ...size });
  const last = await client.tab.open({ runspaceId, cwd: "/b", ...size });
  await store.set(reloadAtom);

  await store.set(createTerminalTabAtom);

  const tabs = (await client.layout.get()).runspaces[0]!.tabs;
  expect(tabs.map((t) => t.id)).toEqual([first.id, expect.any(String), last.id]);
  expect(tabs[1]?.cwd).toBe("/a");
  expect(store.get(activeTerminalTabAtom)?.id).toBe(tabs[1]!.id);
});

test("closing the active Tab leaves its Terminal Session detached and activates the Tab that took its place", async () => {
  const { client, store } = bench();
  const { runspaceId, tab: a } = await client.runspace.create(size);
  const b = await client.tab.open({ runspaceId, ...size });
  const c = await client.tab.open({ runspaceId, ...size });
  await store.set(reloadAtom);
  store.set(activateTerminalTabAtom, b.id);

  await store.set(closeTerminalTabAtom);

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
  expect(store.get(activeTerminalTabAtom)?.id).toBe(c.id);
  expect(await client.terminalSession.list()).toContainEqual(
    expect.objectContaining({ id: b.terminalSessionId, status: "running", tabId: null }),
  );
  expect(shellCalls).toContainEqual({
    command: "terminal_detach",
    args: { sessionId: b.terminalSessionId },
  });
});

test("closing the last Tab of the last Runspace leaves a fresh Runspace", async () => {
  const { client, store } = bench();
  await store.set(reloadAtom);
  const before = (await client.layout.get()).runspaces[0]!;

  await store.set(closeTerminalTabAtom);

  const { runspaces } = await client.layout.get();
  expect(runspaces.map((r) => r.id)).toEqual([expect.not.stringMatching(before.id)]);
  expect(store.get(activeRunspaceAtom)?.id).toBe(runspaces[0]!.id);
});

test("dragging a Runspace onto another puts it in that one's place", async () => {
  const { client, store } = bench();
  const [a, b, c] = [
    await client.runspace.create(size),
    await client.runspace.create(size),
    await client.runspace.create(size),
  ].map((r) => r.runspaceId);
  await store.set(reloadAtom);
  const order = async () => (await client.layout.get()).runspaces.map((r) => r.id);

  await store.set(reorderRunspacesAtom, a!, c!);
  expect(await order()).toEqual([b, c, a]);

  await store.set(reorderRunspacesAtom, a!, b!);
  expect(await order()).toEqual([a, b, c]);
});

test("dragging a Tab onto another in the header puts it in that one's place", async () => {
  const { client, store } = bench();
  const { runspaceId, tab: a } = await client.runspace.create(size);
  const b = await client.tab.open({ runspaceId, ...size });
  const c = await client.tab.open({ runspaceId, ...size });
  await store.set(reloadAtom);

  await store.set(reorderTabsAtom, c.id, a.id);

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([
    c.id,
    a.id,
    b.id,
  ]);
});

test("dropping the active Tab on another Runspace moves it to the end there, and the view follows it", async () => {
  const { client, store } = bench();
  const from = await client.runspace.create(size);
  const kept = await client.tab.open({ runspaceId: from.runspaceId, ...size });
  const to = await client.runspace.create(size);
  await store.set(reloadAtom);
  store.set(activateTerminalTabAtom, from.tab.id);

  await store.set(moveTabToRunspaceAtom, from.tab.id, to.runspaceId);

  expect(
    (await client.layout.get()).runspaces.map((r) => ({ id: r.id, tabs: r.tabs.map((t) => t.id) })),
  ).toEqual([
    { id: from.runspaceId, tabs: [kept.id] },
    { id: to.runspaceId, tabs: [to.tab.id, from.tab.id] },
  ]);
  expect(store.get(activeRunspaceAtom)?.id).toBe(to.runspaceId);
  expect(store.get(activeTerminalTabAtom)?.id).toBe(from.tab.id);
});

test("a Tab whose shell exits while it is connected closes without ever showing the exit", async () => {
  const { client, store } = bench();
  const { runspaceId, tab: a } = await client.runspace.create(size);
  const b = await client.tab.open({ runspaceId, ...size });
  await store.set(reloadAtom);

  // Shell が Exit を受けた時点では、Backend はまだ exit を記録していない。
  const closing = store.set(tabExitedAtom, b.id, 0);
  expect(store.get(terminalSessionStatusAtom)[b.terminalSessionId]?.status).toBe("exited");
  expect(store.get(deadTabsAtom)).toEqual({});
  await closing;

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id]);
  expect(store.get(terminalSessionStatusAtom)[b.terminalSessionId]?.status).toBe("exited");
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([]);
  expect(shellCalls.map((c) => c.command)).not.toContain("terminal_detach");
});

test("Terminate kills the Tab's Terminal Session and closes the Tab, without passing through Detached", async () => {
  const { ptyd, client, store } = bench();
  const { runspaceId, tab: a } = await client.runspace.create(size);
  const b = await client.tab.open({ runspaceId, ...size });
  await store.set(reloadAtom);

  await store.set(terminateTabTerminalSessionAtom, b.id);

  await ptyd.received((op) => op.op === "terminate" && op.session_id === b.terminalSessionId);
  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id]);
  // ptyd がまだ exit を報告していないので、行は live のまま Tab を失っている。
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([]);
});

test("a Terminate that does not reach the Backend leaves the Tab connected to its shell", async () => {
  const { client, store } = bench();
  const { tab } = await client.runspace.create(size);
  await store.set(reloadAtom);
  openTabConnection(tab.id);
  store.set(workbenchClientAtom, null);

  await store.set(terminateTabTerminalSessionAtom, tab.id);

  expect(getTabConnection(tab.id)).toBeDefined();
});

test("New shell binds a Tab whose shell exited to a new running Terminal Session", async () => {
  const { ptyd, client, store } = bench();
  const { tab } = await client.runspace.create(size);
  ptyd.exit(tab.terminalSessionId, 1);
  await ptyd.received((op) => op.op === "reap" && op.session_id === tab.terminalSessionId);
  await store.set(reloadAtom);
  expect(store.get(terminalSessionStatusAtom)[tab.terminalSessionId]).toEqual({
    status: "exited",
    exitCode: 1,
  });

  expect(store.get(deadTabsAtom)[tab.id]).toEqual({ status: "exited", exitCode: 1 });

  await store.set(startNewShellForTabAtom, tab.id);

  const now = (await client.layout.get()).runspaces[0]!.tabs[0]!;
  expect(now.id).toBe(tab.id);
  expect(now.terminalSessionId).not.toBe(tab.terminalSessionId);
  expect(store.get(terminalSessionStatusAtom)[now.terminalSessionId]?.status).toBe("running");
  expect(store.get(deadTabsAtom)).toEqual({});
});

test("a detached Terminal Session sits in the Detached group until it is reattached into the active Runspace", async () => {
  const { client, store } = bench();
  const { runspaceId } = await client.runspace.create(size);
  const closed = await client.tab.open({ runspaceId, ...size });
  await client.tab.close({ id: closed.id });
  const other = await client.runspace.create(size);
  await store.set(reloadAtom);
  store.set(activateRunspaceAtom, other.runspaceId);
  expect(store.get(detachedTerminalSessionsAtom).map((s) => s.id)).toEqual([
    closed.terminalSessionId,
  ]);

  await store.set(reattachTerminalSessionAtom, closed.terminalSessionId);

  expect(store.get(detachedTerminalSessionsAtom)).toEqual([]);
  expect((await client.layout.get()).runspaces[1]!.tabs.map((t) => t.terminalSessionId)).toEqual([
    other.tab.terminalSessionId,
    closed.terminalSessionId,
  ]);
  expect(store.get(activeTerminalTabAtom)?.terminalSessionId).toBe(closed.terminalSessionId);
});

test("Kill in the Detached group terminates the Terminal Session", async () => {
  const { ptyd, client, store } = bench();
  const { runspaceId } = await client.runspace.create(size);
  const closed = await client.tab.open({ runspaceId, ...size });
  await client.tab.close({ id: closed.id });
  await store.set(reloadAtom);

  await store.set(terminateTerminalSessionAtom, closed.terminalSessionId);

  await ptyd.received((op) => op.op === "terminate" && op.session_id === closed.terminalSessionId);
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([]);
});

test("the shell's cwd reaches the Backend only when it differs from the last one", async () => {
  const { workbench, client, store } = bench();
  const { tab } = await client.runspace.create({ cwd: "/a", ...size });
  await store.set(reloadAtom);
  let layoutChanges = 0;
  const controller = new AbortController();
  void (async () => {
    for await (const change of workbench.events.subscribe("change", controller)) {
      if (change.type === "layout") layoutChanges++;
    }
  })().catch(() => {});

  for (const cwd of ["/a", "/b", "/b", "/c", "/c"]) await store.set(updateTabCwdAtom, tab.id, cwd);

  expect((await client.layout.get()).runspaces[0]!.tabs[0]!.cwd).toBe("/c");
  expect(layoutChanges).toBe(2);
  controller.abort();
});

test("a path in the title moves the cwd until the shell reports its cwd itself", async () => {
  const { client, store } = bench();
  const { tab } = await client.runspace.create({ cwd: "/a", ...size });
  await store.set(reloadAtom);
  const cwd = async () => (await client.layout.get()).runspaces[0]!.tabs[0]!.cwd;

  await store.set(updateTabTitleAtom, tab.id, "~/repo");
  expect(await cwd()).toBe(join(homedir(), "repo"));

  await store.set(updateTabCwdAtom, tab.id, "/b");
  await store.set(updateTabTitleAtom, tab.id, "~/c");
  expect(await cwd()).toBe("/b");
});
