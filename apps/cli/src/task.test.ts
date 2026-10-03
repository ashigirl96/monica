import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { issue, issueBlocker, task } from "@tania/task/schema";
import { inMemoryBackend, tania } from "./testing.ts";

function backendWithTasks() {
  const backend = inMemoryBackend();
  const { db } = backend;
  const syncedAt = new Date(0);
  const [blocker, open, closed] = db
    .insert(issue)
    .values([
      { repo: "acme/lib", number: 3, title: "Upstream fix", state: "open", syncedAt },
      { repo: "acme/app", number: 12, title: "Ship it", state: "open", syncedAt },
      { repo: "acme/app", number: 1, title: "Shipped", state: "closed", syncedAt },
    ])
    .returning()
    .all();
  db.insert(issueBlocker).values({ issueId: open!.id, blockerId: blocker!.id }).run();
  db.insert(task)
    .values([
      { issueId: open!.id, trackedAt: new Date(1) },
      { issueId: closed!.id, trackedAt: new Date(2), closedAt: new Date(3) },
    ])
    .run();
  const client = createRouterClient(backend.router, { context: backend.context });
  return () => client;
}

test("task list prints the open Tasks as text", async () => {
  const result = await tania(["task", "list"], backendWithTasks());

  expect(result).toEqual({
    code: 0,
    stdout:
      "REF          TITLE    STATE        BLOCKED BY  CWD\n" +
      "acme/app#12  Ship it  not_started  acme/lib#3  -\n",
    stderr: "",
  });
});

test("task list --closed prints only the closed Tasks", async () => {
  const result = await tania(["task", "list", "--closed"], backendWithTasks());

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("acme/app#1 ");
  expect(result.stdout).not.toContain("acme/app#12");
});

test("task list --format json prints the procedure output as it is", async () => {
  const result = await tania(["task", "list", "--format", "json"], backendWithTasks());

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    tasks: [
      {
        ref: "acme/app#12",
        title: "Ship it",
        issueState: "open",
        blockers: ["acme/lib#3"],
        cwd: null,
        displayState: { state: "not_started" },
      },
    ],
    backgroundSyncError: null,
  });
});

test("task track takes the ref as an argument and refuses a bare #n with exit 1", async () => {
  const result = await tania(["task", "track", "#12"], backendWithTasks());

  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/^BAD_REQUEST: "#12" is not owner\/repo#n[^\n]*\n$/);
});

test("task track exits 1 when GitHub cannot be reached", async () => {
  const result = await tania(["task", "track", "acme/app#99"], backendWithTasks());

  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/^BAD_GATEWAY: could not sync from GitHub: `gh auth token`/);
});

test("task sync takes an optional ref and exits 1 for one that is not tracked", async () => {
  const result = await tania(["task", "sync", "acme/app#99"], backendWithTasks());

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "NOT_FOUND: acme/app#99 is not tracked\n",
  });
});
