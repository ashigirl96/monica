import { Inbox } from "lucide-react";
import { TaskRow } from "./TaskRow";
import type { TaskView } from "./types";

interface TaskListProps {
  items: TaskView[];
  focusedId: string | null;
  openDetailId: string | null;
  onOpen: (item: TaskView) => void;
}

export function TaskList({ items, focusedId, openDetailId, onOpen }: TaskListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Inbox className="size-8 opacity-40" />
        <p className="font-mono text-xs uppercase tracking-[0.2em]">no tasks</p>
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
        <TaskRow
          key={item.id}
          item={item}
          focused={item.id === focusedId}
          detailsOpen={item.id === openDetailId}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
