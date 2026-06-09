import { useAtomValue, useSetAtom } from "jotai";
import {
  activeRunspaceAtom,
  activateTerminalTabAtom,
  closeTerminalTabAtom,
  createTerminalTabAtom,
  reorderTabsAtom,
} from "@/stores/terminal";
import { PlusIcon, WorkBoardIcon, XIcon } from "@/components/icons";
import { activeSpaceAtom } from "@/stores/space";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

export function WorkBenchHeader() {
  const rs = useAtomValue(activeRunspaceAtom);
  const activateTab = useSetAtom(activateTerminalTabAtom);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const createTab = useSetAtom(createTerminalTabAtom);
  const reorder = useSetAtom(reorderTabsAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
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

  if (!rs) return null;

  const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);

  return (
    <div className="scrollbar-hide flex h-full items-center gap-1 overflow-x-auto">
      <button
        onClick={() => setActiveSpace("work-board")}
        className="mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
        title="Work Board"
      >
        <WorkBoardIcon size={14} />
      </button>
      {sorted.map((tab) => {
        const isActive = tab.id === rs.activeTabId;
        const label = tab.title || tab.cwd.split("/").pop() || "Terminal";
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
            onPointerDown={() => activateTab(tab.id)}
            className={cn(
              "group flex h-7 w-[220px] min-w-[220px] max-w-[220px] cursor-pointer items-center rounded-lg px-3 text-xs",
              "transition-colors duration-100",
              isActive
                ? "bg-[var(--content-bg)] text-foreground shadow-sm"
                : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground",
              dragOverId === tab.id && "ring-1 ring-white/20",
            )}
          >
            <span className="flex-1 truncate">{label}</span>
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
