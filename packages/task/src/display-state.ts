import type { DisplayState } from "./contract.ts";
import type { bench as benchTable, issue, task } from "./schema.ts";

export function displayState(
  { closedAt }: Pick<typeof task.$inferSelect, "closedAt">,
  { state }: Pick<typeof issue.$inferSelect, "state">,
  bench: Pick<typeof benchTable.$inferSelect, "setupState"> | null,
): DisplayState {
  if (closedAt) return { state: "closed" };
  if (state === "closed") return { state: "issue_closed" };
  if (!bench) return { state: "not_started" };
  if (bench.setupState === "preparing") return { state: "preparing" };
  if (bench.setupState === "failed") return { state: "setup_failed" };
  return { state: "ended" };
}
