import { expect, test } from "bun:test";
import { displayState } from "./display-state.ts";

const at = new Date(0);

test.each([
  ["closed Task, open Issue", { closedAt: at }, "open", "closed"],
  ["closed Task, closed Issue", { closedAt: at }, "closed", "closed"],
  ["open Task, closed Issue", { closedAt: null }, "closed", "issue_closed"],
  ["open Task, open Issue, no Bench", { closedAt: null }, "open", "not_started"],
] as const)("%s → %s", (_, task, issueState, state) => {
  expect(displayState(task, { state: issueState })).toEqual({ state });
});
