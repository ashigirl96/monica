import { useAtomValue, useSetAtom } from "jotai";
import {
  activeRunspaceAtom,
  activeTerminalTabAtom,
  activateTerminalTabAtom,
  closeTerminalTabAtom,
  createTerminalTabAtom,
  jumpHintTargetsAtom,
  primaryTabByTaskAtom,
  refreshPrimaryTabAtom,
  reorderTabsAtom,
  sessionStatusAtom,
  tabMenuAtom,
} from "@/features/work-bench/store";
import { rectToAnchor } from "@/lib/anchor";
import { statusDisplayLabel, statusDotClass } from "@/lib/status-config";
import { JumpHint } from "./jump-hint";
import { PlusIcon, XIcon } from "@/components/icons";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef } from "react";

const SESSION_STATUS_DOT: Record<string, string> = {
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
  const jumpHints = useAtomValue(jumpHintTargetsAtom);
  const activeTab = useAtomValue(activeTerminalTabAtom);
  const { dragOverId, handlersFor } = useDragReorder(reorder);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [rs?.activeTabId, activeTab?.order]);

  // Hook-driven primary claims land in the DB without a Tauri event, so the
  // indicator follows the same listen-plus-poll pattern as the Workboard.
  // Session status is already polled by the sidebar's useLiveRefresh.
  const refresh = useCallback(() => void refreshPrimaryTab(), [refreshPrimaryTab]);
  useLiveRefresh(refresh);

  // taskId triggers because the restore flow attaches it to an already-rendered
  // runspace; without it the refresh no-ops and the dot waits for the poll.
  useEffect(() => {
    refresh();
  }, [refresh, rs?.id, rs?.taskId]);

  if (!rs) return null;

  const primaryTabId = rs.taskId ? (primaryTabs[rs.taskId] ?? null) : null;

  const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);

  return (
    <div className="scrollbar-hide flex h-full items-center gap-1 overflow-x-auto">
      {sorted.map((tab) => {
        const isActive = tab.id === rs.activeTabId;
        const isMain = tab.id === primaryTabId;
        const label = tab.title || tab.cwd.split("/").pop() || "Terminal";
        const session = tab.sessionId ? sessionStatus[tab.sessionId] : undefined;
        const status = session?.status;
        const terminalDot = status ? SESSION_STATUS_DOT[status] : undefined;
        const agentStatus = session?.agentStatus;
        const agentWaitReason = session?.agentWaitReason ?? null;
        const agentDot = agentStatus ? statusDotClass(agentStatus, agentWaitReason) : undefined;
        const hint = jumpHints.byTabId[tab.id];
        return (
          <button
            key={tab.id}
            ref={isActive ? activeTabRef : undefined}
            {...handlersFor(tab.id, () => activateTab(tab.id))}
            onContextMenu={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setTabMenu({
                tabId: tab.id,
                anchor: { ...rectToAnchor(rect), left: e.clientX },
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
              isMain &&
                "ring-1 ring-emerald-400/60 shadow-[0_0_6px] shadow-emerald-400/25 focus-visible:ring-emerald-300",
              dragOverId === tab.id && "ring-1 ring-sky-400/60",
            )}
            title={isMain ? "Main Run (⌘G elsewhere to promote)" : undefined}
          >
            {hint && <JumpHint hint={hint} className="mr-1.5" />}
            {agentStatus && agentDot && (
              <span
                title={statusDisplayLabel(agentStatus, agentWaitReason)}
                className={cn("mr-1.5 size-1.5 shrink-0 rounded-full", agentDot)}
              />
            )}
            <span className="flex-1 truncate">{label}</span>
            {terminalDot && (
              <span
                title={status}
                className={cn("ml-1.5 size-1.5 shrink-0 rounded-full", terminalDot)}
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
