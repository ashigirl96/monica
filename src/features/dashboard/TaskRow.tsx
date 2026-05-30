import { cn } from "@/lib/utils";
import { GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useRef } from "react";
import { StatusLed } from "./StatusLed";
import { statusColor, statusLabel, waitActionLabel } from "./statusMeta";
import type { TaskView } from "./types";

interface TaskRowProps {
  item: TaskView;
  focused: boolean;
  detailsOpen: boolean;
  onOpen: (item: TaskView) => void;
}

export function TaskRow({ item, focused, detailsOpen, onOpen }: TaskRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const waitAction =
    item.status === "waiting_for_user" ? waitActionLabel(item.task_run_wait_reason) : null;
  const prLabel = pullRequestLabel(item.githubPullRequests);

  useEffect(() => {
    if (!focused) return;
    rowRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <button
      ref={rowRef}
      type="button"
      data-task-row="true"
      onClick={() => onOpen(item)}
      aria-current={detailsOpen ? "true" : undefined}
      className={cn(
        "group relative flex w-full flex-col gap-1.5 border-b border-border/40 px-6 py-4 text-left transition-colors",
        detailsOpen && "bg-foreground/[0.06]",
        focused && "bg-foreground/[0.04] ring-1 ring-inset ring-foreground/20",
        !detailsOpen && !focused && "hover:bg-foreground/[0.03]",
      )}
    >
      {detailsOpen && (
        <span
          className="absolute inset-y-0 left-0 w-0.5"
          style={{ backgroundColor: statusColor(item.status) }}
        />
      )}

      <div className="flex items-center gap-3">
        <StatusLed status={item.status} />
        <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
          {item.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{item.title}</span>
        <span
          className="font-mono text-[11px] uppercase tracking-wide"
          style={{ color: statusColor(item.status) }}
        >
          {statusLabel(item.status)}
        </span>
      </div>

      <div className="flex items-center gap-2 pl-[21px] font-mono text-[11px] text-muted-foreground">
        {item.project && <span className="truncate">{item.project}</span>}
        {item.githubIssueNumber !== null && (
          <span className="text-muted-foreground/70">#{item.githubIssueNumber}</span>
        )}
        {prLabel && (
          <span className="flex items-center gap-1 text-muted-foreground/80">
            <GitPullRequest className="size-3 shrink-0" />
            {prLabel}
          </span>
        )}
        {item.branch && (
          <span className="flex items-center gap-1 truncate text-muted-foreground/80">
            <GitBranch className="size-3 shrink-0" />
            {item.branch}
          </span>
        )}
        {item.phase && (
          <span className="truncate text-muted-foreground/60 italic">· {item.phase}</span>
        )}
        {waitAction && (
          <span className="truncate text-muted-foreground/70">next: {waitAction}</span>
        )}
      </div>
    </button>
  );
}

function pullRequestLabel(pullRequests: TaskView["githubPullRequests"]): string | null {
  if (pullRequests.length === 0) return null;
  if (pullRequests.length === 1) {
    const number = pullRequests[0]?.number;
    return number === null || number === undefined ? "PR" : `#${number}`;
  }
  return `PR x${pullRequests.length}`;
}
