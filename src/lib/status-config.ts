import type { DisplayStatus, TaskRunWaitReason } from "@/commands/task";

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

const STATUS_LABELS: Record<DisplayStatus, string> = {
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

const TASK_STATUS_DOT: Partial<Record<DisplayStatus, string>> = Object.fromEntries(
  SIDEBAR_DOT_STATUSES.map((status) => [status, STATUS_COLORS[status]]),
);

const WAIT_REASON_LABELS: Record<TaskRunWaitReason, string> = {
  ask_user_question: "needs you",
  exit_plan_mode: "approve plan",
  permission_request: "permission",
  awaiting_prompt: "your turn",
};

// waiting_for_user is split by wait_reason. Plan approval is the only one that blocks on
// the user's *decision*, so it gets violet (vs amber) to read as a distinct kind of attention.
const WAIT_BADGE_STYLES: Record<TaskRunWaitReason, string> = {
  ask_user_question: "bg-amber-500/15 text-amber-400",
  exit_plan_mode: "bg-violet-500/15 text-violet-300",
  permission_request: "bg-orange-500/15 text-orange-300",
  awaiting_prompt: "bg-amber-500/10 text-amber-300/80",
};

const WAIT_STATUS_DOT: Record<TaskRunWaitReason, string> = {
  ask_user_question: "bg-amber-400 animate-pulse",
  exit_plan_mode:
    "bg-violet-400 ring-2 ring-violet-400/40 shadow-[0_0_7px_1px_rgba(167,139,250,0.7)] animate-pulse",
  permission_request: "bg-orange-400 animate-pulse",
  awaiting_prompt: "bg-amber-400/40",
};

export function statusDotClass(
  status: DisplayStatus,
  waitReason: TaskRunWaitReason | null,
): string | undefined {
  if (status === "waiting_for_user") return WAIT_STATUS_DOT[waitReason ?? "awaiting_prompt"];
  return TASK_STATUS_DOT[status];
}

export function statusBadgeClass(
  status: DisplayStatus,
  waitReason: TaskRunWaitReason | null,
): string {
  if (status === "waiting_for_user") return WAIT_BADGE_STYLES[waitReason ?? "awaiting_prompt"];
  return STATUS_BADGE_STYLES[status];
}

export function statusDisplayLabel(
  status: DisplayStatus,
  waitReason: TaskRunWaitReason | null,
): string {
  if (status === "waiting_for_user") return WAIT_REASON_LABELS[waitReason ?? "awaiting_prompt"];
  return STATUS_LABELS[status];
}
