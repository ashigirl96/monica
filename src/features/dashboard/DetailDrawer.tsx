import { cn } from "@/lib/utils";
import { GitBranch, GitPullRequest, X } from "lucide-react";
import { EventTimeline } from "./EventTimeline";
import { StatusLed } from "./StatusLed";
import { statusColor, statusLabel, waitActionLabel } from "./statusMeta";
import type { TaskView } from "./types";
import { useEvents } from "./useEvents";

interface DetailDrawerProps {
  item: TaskView | null;
  onClose: () => void;
}

export function DetailDrawer({ item, onClose }: DetailDrawerProps) {
  const { events, loading } = useEvents(item?.id ?? null);

  if (!item) return null;

  const waitAction =
    item.status === "waiting_for_user" ? waitActionLabel(item.task_run_wait_reason) : null;

  return (
    <aside
      className="flex w-[26rem] shrink-0 flex-col border-l border-border/60 bg-card/40"
      style={{ animation: "drawer-in 0.18s ease-out" }}
    >
      <header className="flex items-start gap-3 border-b border-border/50 px-5 py-4">
        <StatusLed status={item.status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{item.id}</span>
            <span
              className="font-mono text-[11px] uppercase tracking-wide"
              style={{ color: statusColor(item.status) }}
            >
              {statusLabel(item.status)}
            </span>
          </div>
          <h2 className="mt-1 text-[15px] leading-snug text-foreground">{item.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-[5rem_1fr] gap-y-2 font-mono text-[11px]">
          <Field label="project" value={item.project} />
          <Field
            label="issue"
            value={item.githubIssueNumber !== null ? `#${item.githubIssueNumber}` : null}
          />
          <Field
            label="branch"
            value={
              item.branch ? (
                <span className="flex items-center gap-1">
                  <GitBranch className="size-3" /> {item.branch}
                </span>
              ) : null
            }
          />
          {item.githubPullRequests.length > 0 && (
            <Field label="pr" value={<PullRequestLinks item={item} />} />
          )}
          {item.phase && <Field label="phase" value={item.phase} />}
          {waitAction && <Field label="next" value={waitAction} />}
          <Field label="created" value={item.created_at.replace("T", " ").slice(0, 19)} />
          <Field label="updated" value={item.updated_at.replace("T", " ").slice(0, 19)} />
        </dl>

        {item.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.labels.map((label) => (
              <span
                key={label}
                className="rounded border border-border/60 bg-foreground/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {item.body.trim() && (
          <div className="mt-4">
            <SectionLabel>body</SectionLabel>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">
              {item.body}
            </p>
          </div>
        )}

        <div className="mt-5">
          <SectionLabel>event timeline</SectionLabel>
          <div className="mt-3">
            <EventTimeline events={events} loading={loading} />
          </div>
        </div>
      </div>
    </aside>
  );
}

function PullRequestLinks({ item }: { item: TaskView }) {
  if (item.githubPullRequests.length === 0) return null;
  return (
    <span className="flex w-full flex-col gap-1">
      {item.githubPullRequests.map((pr, index) => {
        const label = pr.number === null || pr.number === undefined ? "PR" : `#${pr.number}`;
        const key = `${pr.repo ?? "repo"}-${pr.number ?? index}-${pr.url ?? "url"}`;
        const content = !pr.url ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitPullRequest className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        ) : (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
          >
            <GitPullRequest className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
          </a>
        );
        return (
          <span key={key} className="flex items-center justify-between gap-3">
            {content}
            <PullRequestStatusBadge status={pr.status} />
          </span>
        );
      })}
    </span>
  );
}

function PullRequestStatusBadge({
  status,
}: {
  status: TaskView["githubPullRequests"][number]["status"];
}) {
  if (!status) return null;
  const className = {
    draft: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    open: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    closed: "border-muted-foreground/30 bg-foreground/5 text-muted-foreground",
    merged: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  }[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-wide",
        className,
      )}
    >
      {status}
    </span>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <>
      <dt className="text-muted-foreground/60 uppercase tracking-wide">{label}</dt>
      <dd className="text-foreground/90">{value}</dd>
    </>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
