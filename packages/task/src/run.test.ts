import { afterEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { issue, run } from "./schema.ts";
import { cleanUp, setup } from "./testing.ts";

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

function runsOf({ db }: Books) {
  return db
    .select({ number: issue.number, agentSessionId: run.agentSessionId, origin: run.origin })
    .from(run)
    .innerJoin(issue, eq(issue.id, run.taskIssueId))
    .orderBy(run.id)
    .all();
}

async function stateOf({ client }: Books, taskRef = ref) {
  return (await client.list({})).tasks.find((t) => t.ref === taskRef)!.displayState;
}

test("a claude started in a Tab of the Bench becomes a Run of the Task, waiting idle", async () => {
  const books = started();
  const terminalSessionId = books.openTab(await books.openBench(ref));

  await books.hook(terminalSessionId, "s-1", "SessionStart", { source: "startup" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
  expect(await stateOf(books)).toEqual({
    state: "waiting",
    reason: "idle",
    since: expect.any(Date),
    liveRuns: [
      { agentSessionId: "s-1", state: "waiting", reason: "idle", since: expect.any(Date) },
    ],
  });
});

test("a Run stays with its Task while its claude moves out of the Bench, until it ends", async () => {
  const books = started();
  const inBench = books.openTab(await books.openBench(ref));
  const outside = books.openTab(books.plainRunspace());
  await books.hook(inBench, "s-1", "SessionStart", { source: "startup" });

  await books.hook(outside, "s-1", "UserPromptSubmit", { prompt: "go on" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
  expect(await stateOf(books)).toMatchObject({ state: "running" });

  await books.hook(outside, "s-1", "SessionEnd", { reason: "prompt_input_exit" });

  expect(await stateOf(books)).toEqual({ state: "ended" });
});

test("a claude that moves into a Tab of the Bench becomes a Run of the Task then", async () => {
  const books = started();
  const outside = books.openTab(books.plainRunspace());
  const inBench = books.openTab(await books.openBench(ref));
  await books.hook(outside, "s-1", "SessionStart", { source: "startup" });

  expect(runsOf(books)).toEqual([]);

  await books.hook(inBench, "s-1", "SessionStart", { source: "resume" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
});

test("a Run of one Task stays with it when its claude moves into the Bench of another", async () => {
  const books = started();
  const first = books.openTab(await books.openBench(ref));
  const second = books.openTab(await books.openBench("acme/app#13", "Next"));
  await books.hook(first, "s-1", "SessionStart", { source: "startup" });

  await books.hook(second, "s-1", "UserPromptSubmit", { prompt: "go on" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
  expect(await stateOf(books, "acme/app#13")).toEqual({ state: "ended" });
});

test("start makes Runs of the live Agent Sessions already in a Bench, but not of the ended ones", async () => {
  const books = setup();
  books.ghq.origin("acme/app", {});
  const runspaceId = await books.openBench(ref);
  const live = books.openTab(runspaceId);
  const gone = books.openTab(runspaceId);
  await books.hook(live, "s-live", "SessionStart", { source: "startup" });
  await books.hook(gone, "s-gone", "SessionStart", { source: "startup" });
  await books.hook(gone, "s-gone", "SessionEnd", { reason: "prompt_input_exit" });

  expect(runsOf(books)).toEqual([]);

  books.task.start();

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-live", origin: "started" }]);
});

test("a claude begun in the Bench while the Backend was away becomes a Run on its first hook after start", async () => {
  const books = started();
  const inBench = books.openTab(await books.openBench(ref));
  books.restartTask().task.start();

  await books.hook(inBench, "s-1", "UserPromptSubmit", { prompt: "after the restart" });

  expect(runsOf(books)).toEqual([{ number: 12, agentSessionId: "s-1", origin: "started" }]);
});

test("a Task with two live Runs shows the one that waits first and lists both", async () => {
  const books = started();
  const runspaceId = await books.openBench(ref);
  const first = books.openTab(runspaceId);
  const second = books.openTab(runspaceId);
  await books.hook(first, "s-1", "SessionStart", { source: "startup" });
  await books.hook(first, "s-1", "UserPromptSubmit", { prompt: "build it" });
  await books.hook(second, "s-2", "SessionStart", { source: "startup" });
  await books.hook(second, "s-2", "UserPromptSubmit", { prompt: "test it" });

  await books.hook(second, "s-2", "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: "bun test" },
  });

  expect(await stateOf(books)).toMatchObject({
    state: "waiting",
    reason: "permission",
    tool: "Bash",
    liveRuns: [
      { agentSessionId: "s-2", state: "waiting", reason: "permission" },
      { agentSessionId: "s-1", state: "running" },
    ],
  });
});

test("task.changes signals the Task when its Run is made and whenever the Run's claude changes", async () => {
  const books = started();
  const inBench = books.openTab(await books.openBench(ref));
  const outside = books.openTab(books.plainRunspace());
  const changes: unknown[] = [];
  books.task.events.subscribe("change", (change) => changes.push(change));

  await books.hook(inBench, "s-1", "SessionStart", { source: "startup" });
  await books.hook(inBench, "s-1", "UserPromptSubmit", { prompt: "go" });
  await books.hook(outside, "s-2", "SessionStart", { source: "startup" });

  expect(changes).toEqual([
    { type: "task", ref },
    { type: "task", ref },
  ]);
});

test("start signals the Tasks whose Runs it makes", async () => {
  const books = setup();
  books.ghq.origin("acme/app", {});
  const inBench = books.openTab(await books.openBench(ref));
  await books.hook(inBench, "s-1", "SessionStart", { source: "startup" });
  const changes: unknown[] = [];
  books.task.events.subscribe("change", (change) => changes.push(change));

  books.task.start();

  expect(changes).toContainEqual({ type: "task", ref });
});
