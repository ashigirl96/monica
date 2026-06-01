import type { Event } from "./types";

interface EventTimelineProps {
  events: Event[];
  loading: boolean;
}

function summarize(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.status === "string") parts.push(p.status);
  if (typeof p.note === "string" && p.note) parts.push(`"${p.note}"`);
  if (parts.length > 0) return parts.join(" · ");
  const json = JSON.stringify(payload);
  return json === "{}" ? null : json;
}

function clock(iso: string): string {
  const t = iso.slice(11, 19);
  return t || iso;
}

export function EventTimeline({ events, loading }: EventTimelineProps) {
  if (loading && events.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">loading events…</p>;
  }
  if (events.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground/60">no events recorded</p>;
  }

  return (
    <ol className="relative ml-1 flex flex-col gap-0 border-l border-border/50 pl-4">
      {events.map((event) => {
        const summary = summarize(event.payload);
        return (
          <li key={event.id} className="relative pb-4 last:pb-0">
            <span className="absolute -left-[21px] top-1 size-2 rounded-full bg-foreground/40 ring-2 ring-background" />
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
                {clock(event.created_at)}
              </span>
              <span className="font-mono text-xs font-medium text-foreground">{event.kind}</span>
            </div>
            {summary && (
              <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                {summary}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
