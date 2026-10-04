import { expect, test } from "bun:test";
import { benchLabel } from "./bench-label.ts";

test.each([
  ["preparing", { name: "app#12 Ship it", note: "preparing" }],
  ["failed", { name: "app#12 Ship it", note: "setup failed" }],
  ["ready", { name: "app#12 Ship it", note: null }],
] as const)("a Bench that is %s is labelled %o", (setupState, label) => {
  const bench = { runspaceId: "rs-1", ref: "acme/app#12", title: "Ship it", setupState };

  expect(benchLabel(bench)).toEqual(label);
});
