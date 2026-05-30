import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { StatusLed } from "./StatusLed";
import { STATUS_META, STATUS_ORDER } from "./statusMeta";
import type { DisplayStatus, TaskView } from "./types";

export type StatusFilter = DisplayStatus | "all";

interface StatusRailProps {
  items: TaskView[];
  active: StatusFilter;
  onSelect: (filter: StatusFilter) => void;
  onRefresh: () => void;
  refreshing: boolean;
  healthy: boolean;
  lastSync: Date | null;
}

function syncTooltip(healthy: boolean, lastSync: Date | null): string {
  if (!healthy) return "disconnected · click to retry";
  if (!lastSync) return "syncing…";
  const t = lastSync.toTimeString().slice(0, 8);
  return `live · synced ${t} · click to refresh`;
}

export function StatusRail({
  items,
  active,
  onSelect,
  onRefresh,
  refreshing,
  healthy,
  lastSync,
}: StatusRailProps) {
  const counts = new Map<DisplayStatus, number>();
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  const present = STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0);

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-px border-r border-border/60 bg-card/30 py-3">
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          status
        </span>
        <button
          type="button"
          onClick={onRefresh}
          title={syncTooltip(healthy, lastSync)}
          className="-mr-1 rounded p-1 transition-colors hover:bg-foreground/10"
          style={{
            color: healthy ? "var(--st-running)" : "var(--destructive)",
          }}
        >
          <RefreshCw
            className={cn("size-3", refreshing && "animate-spin")}
            style={
              healthy && !refreshing
                ? {
                    ["--led-glow" as string]: "var(--st-running)",
                    animation: "led-pulse 1.8s ease-in-out infinite",
                  }
                : undefined
            }
          />
        </button>
      </div>

      <RailRow
        label="all"
        count={items.length}
        active={active === "all"}
        onClick={() => onSelect("all")}
        led={null}
      />

      <div className="my-2 mx-4 border-t border-border/40" />

      {present.map((status) => (
        <RailRow
          key={status}
          label={STATUS_META[status].label}
          count={counts.get(status) ?? 0}
          active={active === status}
          onClick={() => onSelect(status)}
          led={<StatusLed status={status} />}
        />
      ))}
    </nav>
  );
}

interface RailRowProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  led: React.ReactNode;
}

function RailRow({ label, count, active, onClick, led }: RailRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group mx-2 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        active ? "bg-foreground/10" : "hover:bg-foreground/5",
      )}
    >
      <span className="flex w-3 justify-center">{led}</span>
      <span
        className={cn(
          "flex-1 truncate text-[13px]",
          active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
