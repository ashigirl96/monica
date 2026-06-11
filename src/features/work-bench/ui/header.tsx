import { useAtomValue, useSetAtom } from "jotai";
import {
  activeRunspaceAtom,
  activateTerminalTabAtom,
  closeTerminalTabAtom,
  createTerminalTabAtom,
  primaryTabByTaskAtom,
  refreshPrimaryTabAtom,
  reorderTabsAtom,
  sessionStatusAtom,
  tabMenuAtom,
} from "@/features/work-bench/store";
import { onTaskRunStatusChanged } from "@/commands/task";
import { PlusIcon, XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

const STATUS_DOT: Record<string, string> = {
  exited: "bg-zinc-500",
  lost: "bg-amber-400",
  failed: "bg-red-400",
};

export function WorkBenchHeader() {
  const rs = useAtomValue(activeRunspaceAtom);
  const primaryTabs = useAtomValue(primaryTabByTaskAtom);
  const sessionStatus = useAtomValue(sessionStatusAtom);
  const setTabMenu = useSetAtom(tabMenuAtom);
  const refreshPrimaryTab = useSetAtom(refreshPrimaryTabAtom);
  const activateTab = useSetAtom(activateTerminalTabAtom);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const createTab = useSetAtom(createTerminalTabAtom);
  const reorder = useSetAtom(reorderTabsAtom);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  // CSS cannot trigger scroll-to-element on class change; JS is required
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [rs?.activeTabId]);

  // Hook-driven primary claims land in the DB without a Tauri event, so the
  // indicator follows the same listen-plus-poll pattern as the Workboard.
  // taskId is a dep because the restore flow attaches it to an already-rendered
  // runspace; without it the first refresh no-ops and the dot waits for the poll.
  useEffect(() => {
    void refreshPrimaryTab();
    const unlisten = onTaskRunStatusChanged(() => {
      void refreshPrimaryTab();
    });
    const timer = setInterval(() => {
      if (!document.hidden) void refreshPrimaryTab();
    }, 3000);
    return () => {
      clearInterval(timer);
      unlisten.then((fn) => fn());
    };
  }, [refreshPrimaryTab, rs?.id, rs?.taskId]);

  if (!rs) return null;

  const primaryTabId = rs.taskId ? (primaryTabs[rs.taskId] ?? null) : null;

  const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);

  return (
    <div className="scrollbar-hide flex h-full items-center gap-1 overflow-x-auto">
      {sorted.map((tab) => {
        const isActive = tab.id === rs.activeTabId;
        const isMain = tab.id === primaryTabId;
        const label = tab.title || tab.cwd.split("/").pop() || "Terminal";
        const status = tab.sessionId ? sessionStatus[tab.sessionId]?.status : undefined;
        const statusDot = status ? STATUS_DOT[status] : undefined;
        return (
          <button
            key={tab.id}
            ref={isActive ? activeTabRef : undefined}
            draggable
            onDragStart={() => {
              dragIdRef.current = tab.id;
            }}
            onDragEnd={() => {
              dragIdRef.current = null;
              setDragOverId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverId(tab.id);
            }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverId(null);
              if (dragIdRef.current && dragIdRef.current !== tab.id) {
                reorder(dragIdRef.current, tab.id);
              }
              dragIdRef.current = null;
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              activateTab(tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setTabMenu({
                tabId: tab.id,
                anchor: { top: rect.top, bottom: rect.bottom, left: e.clientX },
                confirmingTerminate: false,
              });
            }}
            className={cn(
              "group flex h-7 w-[220px] min-w-[220px] max-w-[220px] cursor-pointer items-center rounded-lg px-3 text-xs",
              "transition-colors duration-100",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
              isActive
                ? "bg-[var(--content-bg)] text-foreground shadow-sm focus-visible:ring-white/50"
                : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground",
              dragOverId === tab.id && "ring-1 ring-white/20",
            )}
          >
            {isMain && (
              <span
                title="Main Run (⌘G elsewhere to promote)"
                className="mr-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_4px] shadow-emerald-400/60"
              />
            )}
            <span className="flex-1 truncate">{label}</span>
            {statusDot && (
              <span
                title={status}
                className={cn("ml-1.5 size-1.5 shrink-0 rounded-full", statusDot)}
              />
            )}
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded",
                "opacity-0 transition-opacity duration-100 group-hover:opacity-100",
                "hover:bg-white/[0.1]",
              )}
            >
              <XIcon size={10} />
            </span>
          </button>
        );
      })}
      <button
        onClick={() => createTab()}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        title="New tab (Ctrl+T, C)"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}
