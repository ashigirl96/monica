import { cn } from "@/lib/utils";
import { useShortcuts } from "@/lib/shortcuts";
import { PanelLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { deleteTask } from "./api";
import { DeleteTaskModal } from "./DeleteTaskModal";
import { DetailDrawer } from "./DetailDrawer";
import { StatusRail, type StatusFilter } from "./StatusRail";
import { usePullRequestSyncWorker } from "./usePullRequestSyncWorker";
import { useTasks } from "./useTasks";
import { TaskList } from "./TaskList";
import type { TaskView } from "./types";

const RAIL_MIN = 180;
const RAIL_MAX = 420;

export function Dashboard() {
  const { items, loading, error, lastSync, refresh } = useTasks();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(240);
  const [resizing, setResizing] = useState(false);

  usePullRequestSyncWorker({
    enabled: !loading && !error,
    onSynced: refresh,
  });

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.status === filter)),
    [items, filter],
  );

  const focused = useMemo(
    () => visible.find((i) => i.id === focusedId) ?? null,
    [focusedId, visible],
  );

  const openDetail = useMemo(
    () => items.find((i) => i.id === openDetailId) ?? null,
    [items, openDetailId],
  );

  const pendingDelete = useMemo(
    () => items.find((i) => i.id === pendingDeleteId) ?? null,
    [items, pendingDeleteId],
  );

  const focusRelative = (direction: 1 | -1) => {
    if (visible.length === 0) return;
    setFocusedId((current) => {
      const currentIndex = current ? visible.findIndex((item) => item.id === current) : -1;
      if (currentIndex === -1) {
        return direction === 1 ? visible[0].id : visible[visible.length - 1].id;
      }
      return visible[(currentIndex + direction + visible.length) % visible.length].id;
    });
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setPendingDeleteId(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    const targetId = pendingDelete.id;
    const currentIndex = visible.findIndex((item) => item.id === targetId);
    const nextFocus =
      currentIndex === -1 ? null : (visible[currentIndex + 1] ?? visible[currentIndex - 1] ?? null);

    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTask(targetId);
      setPendingDeleteId(null);
      setOpenDetailId((current) => (current === targetId ? null : current));
      setFocusedId(nextFocus?.id ?? null);
      refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  useShortcuts({
    toggleSidebar: () => setRailOpen((open) => !open),
    focusNextTask: () => {
      if (!pendingDeleteId) focusRelative(1);
    },
    focusPreviousTask: () => {
      if (!pendingDeleteId) focusRelative(-1);
    },
    openFocusedTask: () => {
      if (pendingDeleteId) {
        void confirmDelete();
        return;
      }
      if (focused) setOpenDetailId(focused.id);
    },
    closePanel: () => {
      if (pendingDeleteId) {
        closeDeleteModal();
        return;
      }
      setOpenDetailId(null);
    },
    deleteFocusedTask: () => {
      if (!focused || pendingDeleteId) return;
      setPendingDeleteId(focused.id);
      setDeleteError(null);
    },
  });

  useEffect(() => {
    if (focusedId && !visible.some((item) => item.id === focusedId)) {
      setFocusedId(null);
    }
  }, [focusedId, visible]);

  useEffect(() => {
    if (openDetailId && !items.some((item) => item.id === openDetailId)) {
      setOpenDetailId(null);
    }
    if (pendingDeleteId && !items.some((item) => item.id === pendingDeleteId)) {
      setPendingDeleteId(null);
      setDeleteError(null);
    }
  }, [items, openDetailId, pendingDeleteId]);

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
            {openDetail ? openDetail.title : (focused?.title ?? "monica")}
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
              focusedId={focusedId}
              openDetailId={openDetailId}
              onOpen={(item: TaskView) => {
                setFocusedId(item.id);
                setOpenDetailId(item.id);
              }}
            />
          </main>
          <DetailDrawer item={openDetail} onClose={() => setOpenDetailId(null)} />
        </div>
      </div>
      <DeleteTaskModal
        item={pendingDelete}
        deleting={deleting}
        error={deleteError}
        onCancel={closeDeleteModal}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
