import { expect, test } from "bun:test";
import { formatters } from "./cli.ts";
import type { ListItem } from "./contract.ts";

const item = (overrides: Partial<ListItem>): ListItem => ({
  ref: "acme/app#12",
  title: "Ship it",
  issueState: "open",
  blockers: [],
  cwd: null,
  displayState: { state: "not_started" },
  ...overrides,
});

test("track says which Issue it tracked, or that it was already tracked", () => {
  const output = { ref: "acme/app#12", title: "Ship it", alreadyTracked: false, closed: false };

  expect(formatters.track(output)).toBe("tracked acme/app#12 Ship it");
  expect(formatters.track({ ...output, alreadyTracked: true })).toBe("already tracked acme/app#12");
  expect(formatters.track({ ...output, alreadyTracked: true, closed: true })).toBe(
    "already tracked acme/app#12; it is closed, so run `tania task reopen acme/app#12`",
  );
});

test("sync counts the synced Tasks and names the missing Issues", () => {
  expect(formatters.sync({ synced: 1, missing: [] })).toBe("synced 1 Task");
  expect(formatters.sync({ synced: 2, missing: ["acme/app#3", "acme/lib#4"] })).toBe(
    "synced 2 Tasks\nGitHub did not return acme/app#3, acme/lib#4; their copies are kept",
  );
});

test("list prints a table with Blockers in the same repo as #n", () => {
  const text = formatters.list({
    tasks: [
      item({ blockers: ["acme/app#4", "Acme/Lib#3"] }),
      item({ ref: "acme/lib#7", title: "Fix", displayState: { state: "issue_closed" } }),
    ],
    backgroundSyncError: null,
  });

  expect(text).toBe(
    [
      "REF          TITLE    STATE         BLOCKED BY      CWD",
      "acme/app#12  Ship it  not_started   #4, Acme/Lib#3  -",
      "acme/lib#7   Fix      issue_closed  -               -",
    ].join("\n"),
  );
});

test("list ends with a warning when the last background sync failed", () => {
  const text = formatters.list({
    tasks: [],
    backgroundSyncError: { at: new Date(Date.UTC(2026, 9, 4, 3, 0)), message: "acme/app: 502" },
  });

  expect(text).toBe(
    "No Tasks\nwarning: the background sync failed at 2026-10-04T03:00:00.000Z: acme/app: 502",
  );
});

test("list counts a wide character as two columns", () => {
  const text = formatters.list({
    tasks: [item({ title: "写しと sync" }), item({ ref: "acme/app#3", title: "Fix" })],
    backgroundSyncError: null,
  });

  expect(text).toBe(
    [
      "REF          TITLE        STATE        BLOCKED BY  CWD",
      "acme/app#12  写しと sync  not_started  -           -",
      "acme/app#3   Fix          not_started  -           -",
    ].join("\n"),
  );
});

const ago = (ms: number) => new Date(Date.now() - ms);
const liveRun = (agentSessionId: string) => ({
  agentSessionId,
  state: "running" as const,
  since: ago(0),
});

test("list writes the state of a Task with live Runs with its reason, tool, age and other live Runs", () => {
  const text = formatters.list({
    tasks: [
      item({
        displayState: {
          state: "waiting",
          reason: "permission",
          tool: "Bash",
          since: ago(12 * 60_000),
          liveRuns: [liveRun("s-1"), liveRun("s-2")],
        },
      }),
      item({
        ref: "acme/app#3",
        displayState: {
          state: "waiting",
          reason: "error",
          errorType: "rate_limit",
          since: ago(3 * 60_000),
          liveRuns: [liveRun("s-3")],
        },
      }),
      item({
        ref: "acme/app#4",
        displayState: { state: "running", since: ago(30_000), liveRuns: [liveRun("s-4")] },
      }),
      item({
        ref: "acme/app#5",
        displayState: {
          state: "unobserved",
          since: ago(5 * 3_600_000),
          liveRuns: [liveRun("s-5"), liveRun("s-6"), liveRun("s-7")],
        },
      }),
      item({
        ref: "acme/app#6",
        displayState: {
          state: "waiting",
          reason: "idle",
          since: ago(2 * 86_400_000),
          liveRuns: [],
        },
      }),
    ],
    backgroundSyncError: null,
  });

  expect(text.split("\n").map((line) => line.split(/ {2,}/)[2])).toEqual([
    "STATE",
    "waiting:permission(Bash) 12m +1",
    "waiting:error 3m",
    "running 30s",
    "unobserved 5h +2",
    "waiting:idle 2d",
  ]);
});

test("attach names the claude of the Tab and whether attach made it a Run", () => {
  const output = {
    ref: "acme/app#12",
    title: "Ship it",
    benchCreated: false,
    runCreated: true,
    agentSessionId: "s-1",
  };

  expect(formatters.attach(output)).toBe(
    "this Tab is in the Bench of acme/app#12 Ship it\nclaude s-1 is now a Run of acme/app#12",
  );
  expect(formatters.attach({ ...output, runCreated: false })).toBe(
    "this Tab is in the Bench of acme/app#12 Ship it\nclaude s-1 is a Run of acme/app#12",
  );
});

test("close names what it took down, whether the Tab stayed, and the warnings", () => {
  const output = {
    ref: "acme/app#12",
    removedWorktree: "/home/worktrees/acme/app/issue-12",
    deletedBranch: "issue-12",
    spared: true,
    warnings: ["could not sync acme/app#12 from GitHub"],
  };

  expect(formatters.close(output)).toBe(
    [
      "closed acme/app#12",
      "removed the worktree /home/worktrees/acme/app/issue-12",
      "deleted the branch issue-12",
      "this Tab stays, in a Runspace that is no longer a Bench",
      "warning: could not sync acme/app#12 from GitHub",
    ].join("\n"),
  );
  expect(
    formatters.close({
      ...output,
      removedWorktree: null,
      deletedBranch: null,
      spared: false,
      warnings: [],
    }),
  ).toBe("closed acme/app#12");
});

test("reopen names the Task and the warnings", () => {
  expect(formatters.reopen({ ref: "acme/app#12", title: "Ship it", warnings: [] })).toBe(
    "reopened acme/app#12 Ship it",
  );
  expect(formatters.reopen({ ref: "acme/app#12", title: "Ship it", warnings: ["offline"] })).toBe(
    "reopened acme/app#12 Ship it\nwarning: offline",
  );
});

test("current writes the state the same way as list", () => {
  const text = formatters.current({
    ref: "acme/app#12",
    title: "Ship it",
    displayState: {
      state: "waiting",
      reason: "question",
      since: ago(60_000),
      liveRuns: [liveRun("s-1")],
    },
    agentSessionId: "s-1",
    source: "run",
  });

  expect(text).toBe(
    ["REF          TITLE    STATE", "acme/app#12  Ship it  waiting:question 1m"].join("\n"),
  );
});
