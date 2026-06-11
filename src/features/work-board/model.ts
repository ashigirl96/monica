import type { DisplayStatus } from "@/commands/task";

export const PREPARE_ELIGIBLE: Set<DisplayStatus> = new Set([
  "inbox",
  "ready",
  "stopped",
  "failed",
]);

export const RUN_ELIGIBLE: Set<DisplayStatus> = new Set([...PREPARE_ELIGIBLE, "prepared"]);
