import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useSetAtom } from "jotai";
import type { DisplayStatus, TaskSummaryRow } from "@/commands/task";
import { cn } from "@/lib/utils";
import { openBenchAtom, runTaskAndOpenAtom } from "@/stores/workboard";

const STATUS_COLORS: Record<DisplayStatus, string> = {
  inbox: "bg-muted-foreground/40",
  ready: "bg-sky-400",
  in_progress: "bg-blue-500",
  setting_up: "bg-blue-400 animate-pulse",
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
  running: "running",
  waiting_for_user: "needs you",
  stopped: "stopped",
  failed: "failed",
  done: "done",
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

export function TaskCard({ task }: { task: TaskSummaryRow }) {
  const doOpenBench = useSetAtom(openBenchAtom);
  const doRunTaskAndOpen = useSetAtom(runTaskAndOpenAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasIssue = task.github_issue_number > 0;
  const hasPrs = task.github_pull_requests.length > 0;
  const hasBranch = task.branch !== null;
  const hasMetadata = hasIssue || hasPrs || hasBranch;
  const isActive = task.status === "running" || task.status === "setting_up";
  const hasActiveRun = task.active_task_run_id !== null;
  const actionLabel = hasActiveRun ? "Bench" : "Run & Open";

  async function handlePrimaryAction() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (hasActiveRun) {
        await doOpenBench(task.id);
      } else {
        await doRunTaskAndOpen(task.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "group relative flex overflow-hidden rounded-lg border border-border bg-card transition-colors",
        isActive && "border-emerald-500/20",
        "hover:border-muted-foreground/30",
      )}
    >
      <div className={cn("w-1 shrink-0 rounded-l-lg", STATUS_COLORS[task.status])} />

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
          <span className="text-[10px] tracking-wide text-muted-foreground/50 uppercase">
            {STATUS_LABELS[task.status]}
          </span>
          <button
            type="button"
            onClick={handlePrimaryAction}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-opacity",
              "text-muted-foreground opacity-0 group-hover:opacity-70 hover:!opacity-100",
              busy && "opacity-70",
            )}
          >
            <BenchIcon />
            <span>{busy ? "..." : actionLabel}</span>
          </button>
        </div>
        {error && <p className="line-clamp-2 text-[10px] text-red-400">{error}</p>}
      </div>
    </div>
  );
}
