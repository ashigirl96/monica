import { cn } from "@/lib/utils";
import { GitBranch } from "lucide-react";
import { StatusLed } from "./StatusLed";
import { STATUS_META, statusColor } from "./statusMeta";
import type { WorkItemView } from "./types";

interface WorkItemRowProps {
  item: WorkItemView;
  selected: boolean;
  onSelect: (item: WorkItemView) => void;
}

export function WorkItemRow({ item, selected, onSelect }: WorkItemRowProps) {
  const meta = STATUS_META[item.status];
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={cn(
        "group relative flex w-full flex-col gap-1.5 border-b border-border/40 px-5 py-3.5 text-left transition-colors",
        selected ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]",
      )}
    >
      {selected && (
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
          {meta.label}
        </span>
      </div>

      <div className="flex items-center gap-2 pl-[21px] font-mono text-[11px] text-muted-foreground">
        {item.project && <span className="truncate">{item.project}</span>}
        {item.githubIssueNumber !== null && (
          <span className="text-muted-foreground/70">#{item.githubIssueNumber}</span>
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
      </div>
    </button>
  );
}
