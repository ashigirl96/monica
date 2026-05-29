import type { Status } from "./types";

export interface StatusMeta {
  label: string;
  /** CSS variable name (without `var()`) holding this status' accent color. */
  colorVar: string;
  /** Sort weight: lower = higher in the rail and list (live work first). */
  order: number;
  /** Whether the LED should pulse (work is actively in motion). */
  pulse: boolean;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  running: { label: "running", colorVar: "--st-running", order: 0, pulse: true },
  need_approval: { label: "need approval", colorVar: "--st-approval", order: 1, pulse: true },
  setting_up: { label: "setting up", colorVar: "--st-setup", order: 2, pulse: true },
  pr_open: { label: "pr open", colorVar: "--st-pr", order: 3, pulse: false },
  ready: { label: "ready", colorVar: "--st-ready", order: 4, pulse: false },
  inbox: { label: "inbox", colorVar: "--st-inbox", order: 5, pulse: false },
  failed: { label: "failed", colorVar: "--st-failed", order: 6, pulse: false },
  stopped: { label: "stopped", colorVar: "--st-stopped", order: 7, pulse: false },
  done: { label: "done", colorVar: "--st-done", order: 8, pulse: false },
  archived: { label: "archived", colorVar: "--st-archived", order: 9, pulse: false },
};

export const STATUS_ORDER: Status[] = (Object.keys(STATUS_META) as Status[]).sort(
  (a, b) => STATUS_META[a].order - STATUS_META[b].order,
);

export function statusColor(status: Status): string {
  return `var(${STATUS_META[status].colorVar})`;
}
