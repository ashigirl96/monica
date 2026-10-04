import type { BenchItem } from "../contract.ts";

const NOTES = { preparing: "preparing", failed: "setup failed", ready: null } as const;

// sidebar は狭いので repo は owner を除いた名前にする。
export function benchLabel({ ref, title, setupState }: BenchItem) {
  return { name: `${ref.slice(ref.indexOf("/") + 1)} ${title}`, note: NOTES[setupState] };
}
