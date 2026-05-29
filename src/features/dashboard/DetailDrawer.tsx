import { cn } from "@/lib/utils";
import { GitBranch, X } from "lucide-react";
import { useEffect, useState } from "react";
import { listEvents } from "./api";
import { EventTimeline } from "./EventTimeline";
import { StatusLed } from "./StatusLed";
import { STATUS_META, statusColor } from "./statusMeta";
import type { Event, WorkItemView } from "./types";

interface DetailDrawerProps {
  item: WorkItemView | null;
  onClose: () => void;
}

export function DetailDrawer({ item, onClose }: DetailDrawerProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(false);
  const id = item?.id ?? null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setEvents([]);
    setLoading(true);
    listEvents(id)
      .then((e) => {
        if (!cancelled) setEvents(e);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!item) return null;

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
              {STATUS_META[item.status].label}
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
          {item.phase && <Field label="phase" value={item.phase} />}
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
