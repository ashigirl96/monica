import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tab } from "@tania/workbench/schema";
import { eq } from "drizzle-orm";
import { bench, issue, run, task } from "./schema.ts";
import { cleanUp, failure, setup } from "./testing.ts";

afterEach(() => {
  mock.restore();
  cleanUp();
});

type Books = ReturnType<typeof setup>;

const ref = "acme/app#12";

function started() {
  const books = setup();
  books.ghq.origin("acme/app", {});
  books.task.start();
  return books;
}

async function trackedWithoutBench() {
  const books = started();
  books.github.issue(ref, { title: "Ship it" });
  await books.client.track({ ref });
  return books;
}

function runsOf({ db }: Books) {
  return db
    .select({ number: issue.number, agentSessionId: run.agentSessionId, origin: run.origin })
    .from(run)
    .innerJoin(issue, eq(issue.id, run.taskIssueId))
    .orderBy(run.id)
    .all();
}

function runspaceOfTab({ db }: Books, terminalSessionId: string) {
  return db
    .select({ runspaceId: tab.runspaceId })
    .from(tab)
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()?.runspaceId;
}

function tabIdOf({ db }: Books, terminalSessionId: string) {
  return db
    .select({ id: tab.id })
    .from(tab)
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()!.id;
}

// webview の drag は tab.move を呼ぶ。
function drag(books: Books, terminalSessionId: string, runspaceId: string) {
  return books.workbenchClient.tab.move({
    id: tabIdOf(books, terminalSessionId),
    runspaceId,
    index: 0,
  });
}

test("a claude in a Tab dragged into the Bench becomes a Run of the Task, attached", async () => {
  const books = started();
  const benchRunspace = await books.openBench(ref);
  const outside = books.openTab(books.plainRunspace());
  await books.hook(outside, "s-1", "SessionStart", { source: "startup" });

  await drag(books, outside, benchRunspace);

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "attached" }]);
});

test("a Tab dragged into the Bench moves even when its claude is a Run of another Task, which stays its only Run", async () => {
  const books = started();
  const other = books.openTab(await books.openBench("acme/app#13", "Next"));
  const benchRunspace = await books.openBench(ref);
  await books.hook(other, "s-1", "SessionStart", { source: "startup" });

  await drag(books, other, benchRunspace);

  expect(runspaceOfTab(books, other)).toBe(benchRunspace);
  expect(runsOf(books)).toEqual([{ number: 13, agentSessionId: "s-1", origin: "started" }]);
});

test("a layout signal after attach leaves the Run attach made alone, without a failed second insert", async () => {
  const books = started();
  await books.openBench(ref);
  const outside = books.openTab(books.plainRunspace());
  await books.hook(outside, "s-1", "SessionStart", { source: "startup" });
  await books.client.attach({ ref, terminalSessionId: outside });
  const errors = spyOn(console, "error");

  await books.workbenchClient.tab.setCwd({ id: tabIdOf(books, outside), cwd: "/work/elsewhere" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "attached" }]);
  expect(errors).not.toHaveBeenCalled();
});

test("attach moves the calling Tab into the Bench and makes its claude a Run that list shows", async () => {
  const books = started();
  const benchRunspace = await books.openBench(ref);
  const outside = books.openTab(books.plainRunspace());
  await books.hook(outside, "s-1", "SessionStart", { source: "startup" });

  const output = await books.client.attach({ ref, terminalSessionId: outside });

  expect(output).toEqual({
    ref,
    title: "Ship it",
    benchCreated: false,
    runCreated: true,
    agentSessionId: "s-1",
  });
  expect(runspaceOfTab(books, outside)).toBe(benchRunspace);
  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "attached" }]);
  expect((await books.client.list({})).tasks[0]!.displayState).toMatchObject({
    state: "waiting",
    reason: "idle",
    liveRuns: [{ agentSessionId: "s-1" }],
  });
});

test("task.changes signals the Task when attach moves a Tab into its Bench, even one with no claude", async () => {
  const books = started();
  await books.openBench(ref);
  const outside = books.openTab(books.plainRunspace());
  const changes: unknown[] = [];
  books.task.events.subscribe("change", (change) => changes.push(change));

  await books.client.attach({ ref, terminalSessionId: outside });

  expect(changes).toEqual([{ type: "task", ref }]);
});

test("attach succeeds without changing anything for a Tab already in the Bench", async () => {
  const books = started();
  const benchRunspace = await books.openBench(ref);
  const first = books.openTab(benchRunspace);
  books.openTab(benchRunspace);
  await books.hook(first, "s-1", "SessionStart", { source: "startup" });
  const layoutBefore = await books.workbenchClient.layout.get();
  const changes: unknown[] = [];
  books.workbench.events.subscribe("change", (change) => changes.push(change));

  const output = await books.client.attach({ ref, terminalSessionId: first });

  expect(output).toMatchObject({ benchCreated: false, runCreated: false, agentSessionId: "s-1" });
  expect(await books.workbenchClient.layout.get()).toEqual(layoutBefore);
  expect(changes).toEqual([]);
});

test("attach brings back a Tab whose claude is already a Run of the Task without a second Run", async () => {
  const books = started();
  const benchRunspace = await books.openBench(ref);
  const tabbed = books.openTab(benchRunspace);
  await books.hook(tabbed, "s-1", "SessionStart", { source: "startup" });
  await drag(books, tabbed, books.plainRunspace());

  const output = await books.client.attach({ ref, terminalSessionId: tabbed });

  expect(output).toMatchObject({ runCreated: false, agentSessionId: "s-1" });
  expect(runspaceOfTab(books, tabbed)).toBe(benchRunspace);
  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
});

test("attach opens the Bench of a Task that has none in place on the Repo's checkout, ready and without a setup or a clone", async () => {
  const books = await trackedWithoutBench();
  books.ghq.clone("acme/app");
  const setupScript = join(books.ghq.checkout("acme/app"), ".tania/setup.sh");
  mkdirSync(join(setupScript, ".."));
  writeFileSync(setupScript, "#!/bin/sh\ntouch .setup-ran\n", { mode: 0o755 });
  const outside = books.openTab(books.plainRunspace());

  const output = await books.client.attach({ ref, terminalSessionId: outside });

  expect(output).toMatchObject({ benchCreated: true, runCreated: false, agentSessionId: null });
  expect(books.db.select().from(bench).get()).toMatchObject({
    runspaceId: runspaceOfTab(books, outside),
    cwd: books.ghq.checkout("acme/app"),
    mode: "in_place",
    setupState: "ready",
  });
  expect(books.ghq.gets).toEqual([]);
  expect(existsSync(join(books.ghq.checkout("acme/app"), ".setup-ran"))).toBe(false);
  expect((await books.client.list({})).tasks[0]!.displayState).toEqual({ state: "ended" });
});

test("attach opens the Bench on the checkout of the Repo's new name when the Repo is renamed while it looks up ghq root", async () => {
  const books = await trackedWithoutBench();
  const renamed = books.ghq.checkout("acme/renamed");
  mkdirSync(renamed, { recursive: true });
  const root = await books.ghq.client.root();
  let release: (() => void) | undefined;
  spyOn(books.ghq.client, "root").mockImplementation(
    () => new Promise((resolve) => (release = () => resolve(root))),
  );
  const outside = books.openTab(books.plainRunspace());

  const attaching = books.client.attach({ ref, terminalSessionId: outside });
  while (!release) await Bun.sleep(1);
  books.db.update(issue).set({ repo: "acme/renamed" }).run();
  release();

  expect(await attaching).toMatchObject({ ref: "acme/renamed#12", benchCreated: true });
  expect(books.db.select().from(bench).get()).toMatchObject({ cwd: renamed });
});

test("attach refuses a Task that has no Bench and whose Repo is not cloned, changing nothing", async () => {
  const books = await trackedWithoutBench();
  const plain = books.plainRunspace();
  const outside = books.openTab(plain);

  const error = await failure(books.client.attach({ ref, terminalSessionId: outside }));

  expect(error.code).toBe("BAD_REQUEST");
  expect(error.message).toContain("ghq get acme/app");
  expect(books.db.select().from(bench).all()).toEqual([]);
  expect(runspaceOfTab(books, outside)).toBe(plain);
});

test("attach refuses a Tab whose claude is a Run of another Task, changing nothing", async () => {
  const books = started();
  const other = books.openTab(await books.openBench("acme/app#13", "Next"));
  await books.openBench(ref);
  await books.hook(other, "s-1", "SessionStart", { source: "startup" });
  const before = runspaceOfTab(books, other);

  const error = await failure(books.client.attach({ ref, terminalSessionId: other }));

  expect(error).toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("acme/app#13"),
  });
  expect(runspaceOfTab(books, other)).toBe(before);
  expect(runsOf(books)).toEqual([{ number: 13, agentSessionId: "s-1", origin: "started" }]);
});

test("attach refuses a detached Terminal Session, a call from outside a Tab, a closed Task, and an untracked one", async () => {
  const books = started();
  await books.openBench(ref);
  const detached = books.openTab(books.plainRunspace());
  await books.workbenchClient.tab.close({ id: tabIdOf(books, detached) });
  const outside = books.openTab(books.plainRunspace());

  expect((await failure(books.client.attach({ ref, terminalSessionId: detached }))).code).toBe(
    "BAD_REQUEST",
  );
  expect((await failure(books.client.attach({ ref }))).code).toBe("BAD_REQUEST");
  expect(
    (await failure(books.client.attach({ ref: "acme/app#99", terminalSessionId: outside }))).code,
  ).toBe("NOT_FOUND");
  books.db.update(task).set({ closedAt: new Date() }).run();
  expect((await failure(books.client.attach({ ref, terminalSessionId: outside }))).code).toBe(
    "BAD_REQUEST",
  );
});
