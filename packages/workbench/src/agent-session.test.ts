import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startFakePtyd } from "./fake-ptyd.ts";
import { agentSession, terminalSession } from "./schema.ts";
import type { Db } from "./server.ts";
import { cleanUp, onCleanup, setup } from "./testing.ts";

afterEach(cleanUp);

const size = { rows: 24, cols: 80 };

function payload(sessionId: string, hookEventName: string, fields: object = {}) {
  return {
    session_id: sessionId,
    transcript_path: `/transcripts/${sessionId}.jsonl`,
    cwd: "/work",
    hook_event_name: hookEventName,
    ...fields,
  };
}

function rowOf(db: Db, sessionId: string) {
  return db.select().from(agentSession).where(eq(agentSession.sessionId, sessionId)).get();
}

function seedTerminalSession(
  db: Db,
  id: string,
  status: (typeof terminalSession.$inferSelect)["status"],
) {
  db.insert(terminalSession)
    .values({ id, cwd: "/work", shell: "/bin/zsh", status, createdAt: new Date(0) })
    .run();
}

function stderrLines() {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  onCleanup(() => spy.mockRestore());
  return () => spy.mock.calls.map((args) => args.join(" "));
}

test("a claude started in a Tab is listed idle, then follows its hooks until it leaves the list on /exit", async () => {
  const { client } = setup();
  const { tab } = await client.runspace.create(size);
  const record = (hookEventName: string, fields?: object) =>
    client.agentSession.recordHook({
      terminalSessionId: tab.terminalSessionId,
      payload: payload("s-1", hookEventName, fields),
    });

  await record("SessionStart", { source: "startup" });
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({
      sessionId: "s-1",
      terminalSessionId: tab.terminalSessionId,
      state: "waiting",
      waitReason: "idle",
      cwd: "/work",
    }),
  ]);

  await record("UserPromptSubmit", { prompt: "hi" });
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ state: "running", waitReason: null }),
  ]);

  await record("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } });
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ state: "waiting", waitReason: "permission", waitTool: "Bash" }),
  ]);

  await record("SessionEnd", { reason: "prompt_input_exit" });
  expect(await client.agentSession.list()).toEqual([]);
});

test("the first hook of a session the books do not know starts it running before applying", async () => {
  const { db, client } = setup();
  seedTerminalSession(db, "ts-a", "running");

  await client.agentSession.recordHook({
    terminalSessionId: "ts-a",
    payload: payload("s-missed-start", "UserPromptSubmit", { permission_mode: "plan" }),
  });

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({
      sessionId: "s-missed-start",
      terminalSessionId: "ts-a",
      state: "running",
      permissionMode: "plan",
      transcriptPath: "/transcripts/s-missed-start.jsonl",
    }),
  ]);
});

test.each(["exited", "lost", "failed"] as const)(
  "a hook from a Terminal Session that has %s writes nothing and leaves one line on stderr",
  async (status) => {
    const { db, client } = setup();
    seedTerminalSession(db, "ts-ended", status);
    const lines = stderrLines();

    await client.agentSession.recordHook({
      terminalSessionId: "ts-ended",
      payload: payload("s-1", "SessionStart", { source: "startup" }),
    });

    expect(rowOf(db, "s-1")).toBeUndefined();
    expect(lines()).toEqual([expect.stringContaining("ts-ended")]);
  },
);

test("a hook from a Terminal Session the books do not know writes nothing and leaves one line on stderr", async () => {
  const { db, client } = setup();
  const lines = stderrLines();

  await client.agentSession.recordHook({
    terminalSessionId: "ts-leaked",
    payload: payload("s-1", "SessionStart", { source: "startup" }),
  });

  expect(rowOf(db, "s-1")).toBeUndefined();
  expect(lines()).toEqual([expect.stringContaining("ts-leaked")]);
});

test("a session starting in a Terminal Session ends the other live Agent Session there as superseded", async () => {
  const { db, client } = setup();
  seedTerminalSession(db, "ts-a", "running");
  const start = (sessionId: string) =>
    client.agentSession.recordHook({
      terminalSessionId: "ts-a",
      payload: payload(sessionId, "SessionStart", { source: "startup" }),
    });

  await start("s-old");
  await start("s-new");

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: "s-new" }),
  ]);
  expect(rowOf(db, "s-old")).toMatchObject({ state: "ended", endReason: "superseded" });
});

test("a session resumed in another Terminal Session whose SessionStart was missed moves there with its next hook and ends the Agent Session it finds", async () => {
  const { db, client } = setup();
  seedTerminalSession(db, "ts-a", "running");
  seedTerminalSession(db, "ts-b", "running");
  const record = (terminalSessionId: string, sessionId: string, hookEventName: string) =>
    client.agentSession.recordHook({
      terminalSessionId,
      payload: payload(sessionId, hookEventName),
    });
  await record("ts-a", "s-moving", "Stop");
  await record("ts-b", "s-resident", "Stop");

  await record("ts-b", "s-moving", "UserPromptSubmit");

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: "s-moving", terminalSessionId: "ts-b", state: "running" }),
  ]);
  expect(rowOf(db, "s-resident")).toMatchObject({ state: "ended", endReason: "superseded" });
});

test("the books refuse a second live Agent Session in one Terminal Session", () => {
  const { db } = setup();
  seedTerminalSession(db, "ts-a", "running");
  const at = new Date(0);
  const live = (sessionId: string) => ({
    sessionId,
    terminalSessionId: "ts-a",
    state: "running" as const,
    cwd: "/work",
    lastEventName: "UserPromptSubmit",
    lastEventAt: at,
    stateChangedAt: at,
    firstSeenAt: at,
  });
  db.insert(agentSession).values(live("s-1")).run();

  expect(() => db.insert(agentSession).values(live("s-2")).run()).toThrow(/UNIQUE/);
});

test("changes signals every Agent Session a hook changed", async () => {
  const { db, workbench, client } = setup();
  seedTerminalSession(db, "ts-a", "running");
  await client.agentSession.recordHook({
    terminalSessionId: "ts-a",
    payload: payload("s-old", "SessionStart", { source: "startup" }),
  });
  const signals: unknown[] = [];
  onCleanup(workbench.events.subscribe("change", (change) => signals.push(change)));

  await client.agentSession.recordHook({
    terminalSessionId: "ts-a",
    payload: payload("s-new", "SessionStart", { source: "startup" }),
  });

  expect(signals).toHaveLength(2);
  expect(signals).toEqual(
    expect.arrayContaining([
      { type: "agentSession", sessionId: "s-new" },
      { type: "agentSession", sessionId: "s-old" },
    ]),
  );
});

test("an Exit from ptyd ends the Agent Session in that Terminal Session", async () => {
  const { ptyd, db, client } = setup();
  const { tab } = await client.runspace.create(size);
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload("s-1", "UserPromptSubmit", { prompt: "hi" }),
  });

  ptyd.exit(tab.terminalSessionId, 0);
  await ptyd.received((op) => op.op === "reap" && op.session_id === tab.terminalSessionId);

  expect(await client.agentSession.list()).toEqual([]);
  expect(rowOf(db, "s-1")).toMatchObject({ state: "ended", endReason: "terminal_exited" });
});

test("after a Backend restart a running Agent Session is unobserved until its next hook, a waiting one stays, and one whose Terminal Session is gone has ended", async () => {
  const { ptyd, db, client, restartBackend } = setup();
  const record = (terminalSessionId: string, sessionId: string, hookEventName: string) =>
    client.agentSession.recordHook({
      terminalSessionId,
      payload: payload(sessionId, hookEventName),
    });
  const busy = (await client.runspace.create(size)).tab.terminalSessionId;
  const waiting = (await client.runspace.create(size)).tab.terminalSessionId;
  const gone = (await client.runspace.create(size)).tab.terminalSessionId;
  await record(busy, "s-busy", "UserPromptSubmit");
  await record(waiting, "s-waiting", "Stop");
  await record(gone, "s-gone", "UserPromptSubmit");
  ptyd.sessions.splice(
    ptyd.sessions.findIndex((s) => s.session_id === gone),
    1,
  );

  const after = restartBackend();
  await after.workbench.start();

  expect(await after.client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: "s-busy", state: "unobserved" }),
    expect.objectContaining({ sessionId: "s-waiting", state: "waiting", waitReason: "idle" }),
  ]);
  expect(rowOf(db, "s-gone")).toMatchObject({ state: "ended", endReason: "terminal_exited" });

  await after.client.agentSession.recordHook({
    terminalSessionId: busy,
    payload: payload("s-busy", "PostToolUse", { tool_name: "Bash" }),
  });
  expect(rowOf(db, "s-busy")).toMatchObject({ state: "running", unobservedSince: null });
});

test("reconnecting to ptyd while the Backend keeps running leaves a running Agent Session running", async () => {
  const { home, ptyd, workbench, client } = setup();
  const { tab } = await client.runspace.create(size);
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload("s-1", "UserPromptSubmit", { prompt: "hi" }),
  });
  const reconciled = new Promise<void>((resolve) => {
    const unsubscribe = workbench.events.subscribe("change", (change) => {
      if (change.type !== "reconciled") return;
      unsubscribe();
      resolve();
    });
  });

  ptyd.stop();
  await Bun.sleep(50);
  const revived = startFakePtyd(home);
  onCleanup(() => revived.stop());
  revived.sessions.push(...ptyd.sessions);
  await reconciled;

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: "s-1", state: "running" }),
  ]);
});
