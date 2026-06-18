import { openUrl } from "@tauri-apps/plugin-opener";
import type { TaskSummaryRow } from "@/commands/task";
import {
  STATUS_BADGE_STYLES,
  STATUS_COLORS,
  statusBadgeClass,
  statusDisplayLabel,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";
import { issueUrl } from "@/features/work-board/github-urls";
import { IssueIcon, PrIcon } from "@/features/work-board/ui/github-icons";

function BranchIcon() {
  return (
    <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function BadgeLink({
  url,
  className,
  children,
}: {
  url: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  if (url) {
    return (
      <button
        type="button"
        onClick={() => openUrl(url)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1.5 py-px text-[11px] transition-opacity hover:opacity-80",
          className,
        )}
      >
        {children}
      </button>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm px-1.5 py-px text-[11px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

// Side runs never drive the card's column; they only get a quiet attention
// cluster next to the main status badge.
function SideRunBadges({ task }: { task: TaskSummaryRow }) {
  const entries = [
    {
      kind: "waiting",
      count: task.side_runs_waiting_for_user,
      title: (n: number) => `${n} side run${n > 1 ? "s" : ""} waiting for you`,
      className: STATUS_BADGE_STYLES.waiting_for_user,
      dot: STATUS_COLORS.waiting_for_user,
    },
    {
      kind: "failed",
      count: task.side_runs_failed,
      title: (n: number) => `${n} side run${n > 1 ? "s" : ""} failed`,
      className: STATUS_BADGE_STYLES.failed,
      dot: STATUS_COLORS.failed,
    },
    // running stays deliberately subdued: a healthy side run is not an attention item
    {
      kind: "running",
      count: task.side_runs_running,
      title: (n: number) => `${n} side run${n > 1 ? "s" : ""} running`,
      className: "bg-white/[0.04] text-muted-foreground",
      dot: "bg-emerald-400/70",
    },
  ].filter((e) => e.count > 0);
  if (entries.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1">
      {entries.map((e) => (
        <span
          key={e.kind}
          title={e.title(e.count)}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[10px] font-medium",
            e.className,
          )}
        >
          <span className={cn("size-1 rounded-full", e.dot)} />+{e.count}
        </span>
      ))}
    </span>
  );
}

export function TaskCard({ task, focused }: { task: TaskSummaryRow; focused: boolean }) {
  const hasIssue = task.github_issue_number !== null;
  const hasBranch = task.branch !== null;
  const statusLabel = statusDisplayLabel(task.status, task.task_run_wait_reason);
  const statusBadgeStyle = statusBadgeClass(task.status, task.task_run_wait_reason);

  return (
    <div
      data-task-id={task.id}
      data-focused={focused || undefined}
      tabIndex={-1}
      className={cn(
        "group relative flex shrink-0 overflow-hidden rounded-lg border border-border bg-card transition-colors outline-none",
        task.is_active && "border-emerald-500/20",
        "hover:border-muted-foreground/30",
        focused && "border-muted-foreground/30 ring-1 ring-foreground/40",
      )}
    >
      <div
        className={cn(
          "shrink-0 rounded-l-lg transition-[width]",
          focused ? "w-1.5" : "w-1",
          STATUS_COLORS[task.status],
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[9px] font-semibold tracking-wider text-muted-foreground/50 uppercase">
            {task.project}
          </span>
          <span className="shrink-0 font-mono text-[10px] tracking-tight text-muted-foreground/60">
            {task.id}
          </span>
        </div>

        <p className="text-[13px] leading-snug font-medium">{task.title}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center rounded-sm px-1.5 py-px text-[10px] font-medium",
              statusBadgeStyle,
            )}
          >
            {statusLabel}
          </span>
          {hasIssue && (
            <BadgeLink
              url={issueUrl(task.project, task.github_issue_number)}
              className="bg-secondary text-muted-foreground"
            >
              <IssueIcon />
              <span>{task.github_issue_number}</span>
            </BadgeLink>
          )}
          {task.github_pull_requests.map((pr) => (
            <BadgeLink
              key={pr.number}
              url={pr.url}
              className={cn(
                pr.status === "merged"
                  ? "bg-purple-500/15 text-purple-400"
                  : pr.status === "open" || pr.status === "draft"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              <PrIcon />
              <span>{pr.number}</span>
            </BadgeLink>
          ))}
          {hasBranch && (
            <span className="inline-flex items-center gap-0.5 rounded-sm bg-secondary px-1.5 py-px text-[11px] text-muted-foreground">
              <BranchIcon />
              <span className="max-w-28 truncate">{task.branch}</span>
            </span>
          )}
          <SideRunBadges task={task} />
        </div>
      </div>

      {task.has_open_pull_request && (
        <div title="open pull request" className="w-1 shrink-0 rounded-r-lg bg-emerald-400/70" />
      )}
    </div>
  );
}
