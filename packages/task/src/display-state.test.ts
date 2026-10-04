import { expect, test } from "bun:test";
import { displayState } from "./display-state.ts";

const at = new Date(0);

test.each([
  ["closed Task, open Issue", { closedAt: at }, "open", null, "closed"],
  ["closed Task, closed Issue", { closedAt: at }, "closed", null, "closed"],
  ["open Task, closed Issue", { closedAt: null }, "closed", null, "issue_closed"],
  ["open Task, closed Issue, ready Bench", { closedAt: null }, "closed", "ready", "issue_closed"],
  ["open Task, open Issue, no Bench", { closedAt: null }, "open", null, "not_started"],
  ["Bench preparing", { closedAt: null }, "open", "preparing", "preparing"],
  ["Bench failed to prepare", { closedAt: null }, "open", "failed", "setup_failed"],
  ["Bench ready, no live Run", { closedAt: null }, "open", "ready", "ended"],
] as const)("%s → %s", (_, task, issueState, setupState, state) => {
  const bench = setupState === null ? null : { setupState };
  expect(displayState(task, { state: issueState }, bench)).toEqual({ state });
});
