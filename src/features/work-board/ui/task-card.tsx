import { openUrl } from "@tauri-apps/plugin-opener";
import { useSetAtom } from "jotai";
import type { DisplayStatus, TaskSummaryRow } from "@/commands/task";
import { cn } from "@/lib/utils";
import { PREPARE_ELIGIBLE, RUN_ELIGIBLE } from "@/features/work-board/model";
import { openBenchAtom, prepareTaskAtom, runTaskAtom } from "@/stores/workboard";

const STATUS_COLORS: Record<DisplayStatus, string> = {
  inbox: "bg-muted-foreground/40",
  ready: "bg-sky-400",
  in_progress: "bg-blue-500",
  setting_up: "bg-blue-400 animate-pulse",
  prepared: "bg-cyan-400",
  running: "bg-emerald-400 animate-pulse",
  waiting_for_user: "bg-amber-400",
  stopped: "bg-muted-foreground/50",
  failed: "bg-red-400",
  done: "bg-muted-foreground/30",
};

const STATUS_LABELS: Record<DisplayStatus, string> = {
  inbox: "inbox",
  ready: "ready",
  in_progress: "in progress",
  setting_up: "setting up",
  prepared: "prepared",
  running: "running",
  waiting_for_user: "needs you",
  stopped: "stopped",
  failed: "failed",
  done: "done",
};

const STATUS_BADGE_STYLES: Record<DisplayStatus, string> = {
  inbox: "bg-muted text-muted-foreground",
  ready: "bg-sky-500/15 text-sky-400",
  in_progress: "bg-blue-500/15 text-blue-400",
  setting_up: "bg-blue-500/15 text-blue-400 animate-pulse",
  prepared: "bg-cyan-500/15 text-cyan-400",
  running: "bg-emerald-500/15 text-emerald-400 animate-pulse",
  waiting_for_user: "bg-amber-500/15 text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-400",
  done: "bg-muted text-muted-foreground/60",
};

function IssueIcon() {
  return (
    <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  );
}

function PrIcon() {
  return (
    <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function BenchIcon() {
  return (
    <svg
      className="size-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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

function issueUrl(project: string | null, number: number): string | null {
  if (!project) return null;
  return `https://github.com/${project}/issues/${number}`;
}

function RunIcon() {
  return (
    <svg className="size-3" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function PrepareIcon() {
  return (
    <svg
      className="size-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

// Side runs never drive the card's column; they only get a quiet attention
// cluster next to the main status badge.
function SideRunBadges({ task }: { task: TaskSummaryRow }) {
  const entries = [
    {
      count: task.side_runs_waiting_for_user,
      title: (n: number) => `${n} side run${n > 1 ? "s" : ""} waiting for you`,
      className: STATUS_BADGE_STYLES.waiting_for_user,
      dot: STATUS_COLORS.waiting_for_user,
    },
    {
      count: task.side_runs_failed,
      title: (n: number) => `${n} side run${n > 1 ? "s" : ""} failed`,
      className: STATUS_BADGE_STYLES.failed,
      dot: STATUS_COLORS.failed,
    },
    // running stays deliberately subdued: a healthy side run is not an attention item
    {
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
          key={e.dot}
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
  const doOpenBench = useSetAtom(openBenchAtom);
  const doPrepareTask = useSetAtom(prepareTaskAtom);
  const doRunTask = useSetAtom(runTaskAtom);
  const hasIssue = task.github_issue_number > 0;
  const hasPrs = task.github_pull_requests.length > 0;
  const hasBranch = task.branch !== null;
  const hasMetadata = hasIssue || hasPrs || hasBranch;
  const isActive =
    task.status === "running" || task.status === "setting_up" || task.status === "prepared";

  return (
    <div
      data-task-id={task.id}
      data-focused={focused || undefined}
      tabIndex={-1}
      className={cn(
        "group relative flex overflow-hidden rounded-lg border border-border bg-card transition-colors outline-none",
        isActive && "border-emerald-500/20",
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
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] leading-snug font-medium">{task.title}</p>
          </div>
          <span className="shrink-0 font-mono text-[10px] tracking-tight text-muted-foreground/60">
            {task.id}
          </span>
        </div>

        {hasMetadata && (
          <div className="flex flex-wrap items-center gap-1.5">
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
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center rounded-sm px-1.5 py-px text-[10px] font-medium",
                STATUS_BADGE_STYLES[task.status],
              )}
            >
              {STATUS_LABELS[task.status]}
            </span>
            <SideRunBadges task={task} />
          </span>
          <div className="flex items-center gap-1">
            {PREPARE_ELIGIBLE.has(task.status) && (
              <button
                type="button"
                onClick={() => doPrepareTask(task.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-opacity",
                  "text-muted-foreground hover:!opacity-100",
                  focused ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                )}
              >
                <PrepareIcon />
                <span>Prepare</span>
              </button>
            )}
            {RUN_ELIGIBLE.has(task.status) && (
              <button
                type="button"
                onClick={() => doRunTask(task.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-opacity",
                  "text-emerald-400 hover:!opacity-100",
                  focused ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                )}
              >
                <RunIcon />
                <span>Run</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => doOpenBench(task.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-opacity",
                "text-muted-foreground opacity-0 group-hover:opacity-70 hover:!opacity-100",
              )}
            >
              <BenchIcon />
              <span>Bench</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
