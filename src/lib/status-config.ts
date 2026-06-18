import type { DisplayStatus } from "@/commands/task";

export const STATUS_COLORS: Record<DisplayStatus, string> = {
  ready: "bg-sky-400",
  in_progress: "bg-blue-500",
  setting_up: "bg-blue-400 animate-pulse",
  prepared: "bg-cyan-400",
  running: "bg-emerald-400 animate-pulse",
  waiting_for_user: "bg-amber-400",
  stopped: "bg-muted-foreground/50",
  failed: "bg-red-400",
  closed: "bg-muted-foreground/30",
};

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  ready: "ready",
  in_progress: "in progress",
  setting_up: "setting up",
  prepared: "prepared",
  running: "running",
  waiting_for_user: "needs you",
  stopped: "stopped",
  failed: "failed",
  closed: "closed",
};

export const STATUS_BADGE_STYLES: Record<DisplayStatus, string> = {
  ready: "bg-sky-500/15 text-sky-400",
  in_progress: "bg-blue-500/15 text-blue-400",
  setting_up: "bg-blue-500/15 text-blue-400 animate-pulse",
  prepared: "bg-cyan-500/15 text-cyan-400",
  running: "bg-emerald-500/15 text-emerald-400 animate-pulse",
  waiting_for_user: "bg-amber-500/15 text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-400",
  closed: "bg-muted text-muted-foreground/60",
};

// The sidebar only shows a status dot for in-flight states; ready / in_progress /
// closed are intentionally omitted so a dot's presence signals attention.
const SIDEBAR_DOT_STATUSES = [
  "setting_up",
  "prepared",
  "running",
  "waiting_for_user",
  "stopped",
  "failed",
] satisfies DisplayStatus[];

export const TASK_STATUS_DOT: Partial<Record<DisplayStatus, string>> = Object.fromEntries(
  SIDEBAR_DOT_STATUSES.map((status) => [status, STATUS_COLORS[status]]),
);
