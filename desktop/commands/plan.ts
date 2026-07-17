import { commands, type PlanPreview } from "./bindings";
import { unwrap } from "./unwrap";

export type { PlanPreview };

export function readRunspacePlan(terminalTabId: string) {
  return unwrap(commands.readRunspacePlan(terminalTabId));
}
