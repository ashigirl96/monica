import type { DisplayState } from "./contract.ts";
import type { issue, task } from "./schema.ts";

export function displayState(
  { closedAt }: Pick<typeof task.$inferSelect, "closedAt">,
  { state }: Pick<typeof issue.$inferSelect, "state">,
): DisplayState {
  if (closedAt) return { state: "closed" };
  if (state === "closed") return { state: "issue_closed" };
  return { state: "not_started" };
}
