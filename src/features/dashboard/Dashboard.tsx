import { cn } from "@/lib/utils";
import { useShortcuts } from "@/lib/shortcuts";
import { PanelLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { DetailDrawer } from "./DetailDrawer";
import { StatusRail, type StatusFilter } from "./StatusRail";
import { useTasks } from "./useTasks";
import { TaskList } from "./TaskList";
import type { TaskView } from "./types";

const RAIL_MIN = 180;
const RAIL_MAX = 420;

export function Dashboard() {
  const { items, loading, error, lastSync, refresh } = useTasks();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(240);
  const [resizing, setResizing] = useState(false);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.status === filter)),
    [items, filter],
  );

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  useShortcuts({
    toggleSidebar: () => setRailOpen((open) => !open),
  });

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = railWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const next = startWidth + ev.clientX - startX;
      setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, next)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="relative flex h-screen bg-transparent text-foreground">
      <button
        type="button"
        onClick={() => setRailOpen((open) => !open)}
        title={railOpen ? "サイドバーを閉じる (⌘1)" : "サイドバーを開く (⌘1)"}
        className="absolute top-[14px] left-[90px] z-50 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <PanelLeft className="size-4" />
      </button>

      <div
        className="shrink-0 overflow-hidden"
        style={{
          width: railOpen ? railWidth : 0,
          transition: resizing ? "none" : "width 200ms ease",
        }}
      >
        <StatusRail
          width={railWidth}
          items={items}
          active={filter}
          onSelect={setFilter}
          onRefresh={refresh}
          refreshing={loading}
          healthy={!error}
          lastSync={lastSync}
        />
      </div>

      <div
        className={cn(
          "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background",
          railOpen && "rounded-tl-xl border-l border-t border-border/60",
        )}
      >
        {railOpen && (
          <div
            onMouseDown={startResize}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-foreground/20"
          />
        )}

        <header
          data-tauri-drag-region
          className="flex h-14 shrink-0 items-center border-b border-border/60 pr-6"
          style={{
            paddingLeft: railOpen ? 24 : 124,
            transition: resizing ? "none" : "padding-left 200ms ease",
          }}
        >
          <span className="pointer-events-none truncate text-sm text-foreground select-none">
            {selected ? selected.title : "monica"}
          </span>
        </header>

        {error && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-5 py-2 font-mono text-[11px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
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
    </div>
  );
}
