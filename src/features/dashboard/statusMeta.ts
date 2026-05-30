import type { DisplayStatus, TaskRunWaitReason } from "./types";

export interface StatusMeta {
  label: string;
  /** CSS variable name (without `var()`) holding this status' accent color. */
  colorVar: string;
  /** Sort weight: lower = higher in the rail and list (live work first). */
  order: number;
  /** Whether the LED should pulse (work is actively in motion). */
  pulse: boolean;
}

export const STATUS_META: Record<DisplayStatus, StatusMeta> = {
  running: { label: "running", colorVar: "--st-running", order: 0, pulse: true },
  waiting_for_user: {
    label: "waiting for you",
    colorVar: "--st-waiting",
    order: 1,
    pulse: true,
  },
  setting_up: { label: "setting up", colorVar: "--st-setup", order: 2, pulse: true },
  ready: { label: "ready", colorVar: "--st-ready", order: 3, pulse: false },
  in_progress: { label: "in progress", colorVar: "--st-progress", order: 4, pulse: false },
  inbox: { label: "inbox", colorVar: "--st-inbox", order: 5, pulse: false },
  failed: { label: "run failed", colorVar: "--st-failed", order: 6, pulse: false },
  stopped: { label: "stopped", colorVar: "--st-stopped", order: 7, pulse: false },
  done: { label: "done", colorVar: "--st-done", order: 8, pulse: false },
};

export const STATUS_ORDER: DisplayStatus[] = (Object.keys(STATUS_META) as DisplayStatus[]).sort(
  (a, b) => STATUS_META[a].order - STATUS_META[b].order,
);

export function statusColor(status: DisplayStatus): string {
  return `var(${STATUS_META[status].colorVar})`;
}

export function statusLabel(status: DisplayStatus): string {
  return STATUS_META[status].label;
}

export function waitActionLabel(reason?: TaskRunWaitReason | null): string | null {
  if (reason === "exit_plan_mode") return "approve plan";
  if (reason === "ask_user_question") return "answer question";
  return null;
}
