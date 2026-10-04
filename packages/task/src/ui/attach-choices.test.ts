import { expect, test } from "bun:test";
import type { ListItem } from "../contract.ts";
import { attachChoices } from "./attach-choices.ts";

const item = (ref: string, displayState: ListItem["displayState"]): ListItem => ({
  ref,
  title: "Ship it",
  issueState: "open",
  blockers: [],
  cwd: null,
  displayState,
});

const since = new Date(0);
const tracked = [
  item("acme/app#1", { state: "not_started" }),
  item("acme/app#2", {
    state: "running",
    since,
    liveRuns: [{ agentSessionId: "s-run", state: "running", since }],
  }),
  item("acme/app#3", { state: "ended" }),
];

test("the open Tasks to attach to are listed newest tracked first, for a Tab with no agent or one that is no Run", () => {
  const newestFirst = ["acme/app#3", "acme/app#2", "acme/app#1"];

  expect(attachChoices(tracked, null)?.map((t) => t.ref)).toEqual(newestFirst);
  expect(attachChoices(tracked, "s-free")?.map((t) => t.ref)).toEqual(newestFirst);
});

test("a Tab whose claude is a Run of a Task has nothing to attach to", () => {
  expect(attachChoices(tracked, "s-run")).toBeNull();
});
