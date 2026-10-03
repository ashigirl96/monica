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
