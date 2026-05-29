import { Inbox } from "lucide-react";
import { WorkItemRow } from "./WorkItemRow";
import type { WorkItemView } from "./types";

interface WorkItemListProps {
  items: WorkItemView[];
  selectedId: string | null;
  onSelect: (item: WorkItemView) => void;
}

export function WorkItemList({ items, selectedId, onSelect }: WorkItemListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Inbox className="size-8 opacity-40" />
        <p className="font-mono text-xs uppercase tracking-[0.2em]">no work items</p>
        <p className="max-w-xs text-center text-sm text-muted-foreground/70">
          track a GitHub issue with{" "}
          <code className="font-mono text-foreground/80">monica issue track</code> to populate this
          view.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {items.map((item) => (
        <WorkItemRow
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
