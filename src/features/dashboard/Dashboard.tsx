import { useMemo, useState } from "react";
import { DetailDrawer } from "./DetailDrawer";
import { StatusRail, type StatusFilter } from "./StatusRail";
import { useTasks } from "./useTasks";
import { TaskList } from "./TaskList";
import type { TaskView } from "./types";

export function Dashboard() {
  const { items, loading, error, lastSync, refresh } = useTasks();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.status === filter)),
    [items, filter],
  );

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-5 py-2 font-mono text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <StatusRail
          items={items}
          active={filter}
          onSelect={setFilter}
          onRefresh={refresh}
          refreshing={loading}
          healthy={!error}
          lastSync={lastSync}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <TaskList
            items={visible}
            selectedId={selectedId}
            onSelect={(item: TaskView) =>
              setSelectedId((prev) => (prev === item.id ? null : item.id))
            }
          />
        </main>
        <DetailDrawer item={selected} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}
