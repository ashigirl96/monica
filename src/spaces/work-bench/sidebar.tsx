import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  runspaceSummariesAtom,
  activateRunspaceAtom,
  detachedSessionsAtom,
  reattachSessionAtom,
  refreshSessionsAtom,
  reorderRunspacesAtom,
  type RunspaceSummary,
} from "@/stores/terminal";
import { terminalTerminate, type TerminalSession } from "@/commands/terminal";
import { activeSpaceAtom } from "@/stores/space";
import { cn } from "@/lib/utils";

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? path;
}

function DetachedSessionItem({
  session,
  onReattach,
  onTerminate,
}: {
  session: TerminalSession;
  onReattach: () => void;
  onTerminate: () => void;
}) {
  return (
    <div className="group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-muted-foreground">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{shortPath(session.cwd)}</span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
          {session.id}
        </span>
      </div>
      <button
        type="button"
        onClick={onReattach}
        className="rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.1] hover:text-foreground"
      >
        Reattach
      </button>
      <button
        type="button"
        onClick={onTerminate}
        className="rounded px-1.5 py-0.5 text-[10px] text-destructive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/15"
      >
        Kill
      </button>
    </div>
  );
}

function RunspaceItem({
  ws,
  onActivate,
  dragState,
}: {
  ws: RunspaceSummary;
  onActivate: () => void;
  dragState: {
    dragIdRef: React.RefObject<string | null>;
    dragOverId: string | null;
    setDragOverId: (id: string | null) => void;
    reorder: (from: string, to: string) => void;
  };
}) {
  return (
    <button
      draggable
      onDragStart={() => {
        dragState.dragIdRef.current = ws.id;
      }}
      onDragEnd={() => {
        dragState.dragIdRef.current = null;
        dragState.setDragOverId(null);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        dragState.setDragOverId(ws.id);
      }}
      onDragLeave={() => dragState.setDragOverId(null)}
      onDrop={(e) => {
        e.preventDefault();
        dragState.setDragOverId(null);
        if (dragState.dragIdRef.current && dragState.dragIdRef.current !== ws.id) {
          dragState.reorder(dragState.dragIdRef.current, ws.id);
        }
        dragState.dragIdRef.current = null;
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        onActivate();
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
        ws.isActive
          ? "bg-white/[0.1] text-foreground focus-visible:ring-white/50"
          : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
        dragState.dragOverId === ws.id && "ring-1 ring-white/20",
      )}
    >
      <div className="flex items-center gap-1.5">
        {ws.taskId && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-px font-mono text-[9px] text-emerald-400">
            {ws.taskId}
          </span>
        )}
        <span className="truncate text-xs font-medium">{ws.title || "Terminal"}</span>
      </div>
      {ws.description && (
        <span className="truncate text-[10px] text-muted-foreground">{ws.description}</span>
      )}
    </button>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1">
      <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/50 uppercase">
        {label}
      </span>
    </div>
  );
}

export function WorkBenchSidebar() {
  const summaries = useAtomValue(runspaceSummariesAtom);
  const detachedSessions = useAtomValue(detachedSessionsAtom);
  const activate = useSetAtom(activateRunspaceAtom);
  const reattach = useSetAtom(reattachSessionAtom);
  const refreshSessions = useSetAtom(refreshSessionsAtom);
  const reorder = useSetAtom(reorderRunspacesAtom);
  const setSpace = useSetAtom(activeSpaceAtom);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  // Session status lives in the DB and the daemon; like the primary-tab indicator it has
  // no push channel for every change, so poll while visible.
  useEffect(() => {
    void refreshSessions();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshSessions();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  const { taskBound, shells } = useMemo(() => {
    const taskBound = summaries.filter((s) => s.taskId);
    const shells = summaries.filter((s) => !s.taskId);
    return { taskBound, shells };
  }, [summaries]);

  const dragState = { dragIdRef, dragOverId, setDragOverId, reorder };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {taskBound.length > 0 && (
          <>
            <GroupHeader label="Task Runs" />
            <div className="flex flex-col gap-0.5 px-0.5">
              {taskBound.map((ws) => (
                <RunspaceItem
                  key={ws.id}
                  ws={ws}
                  onActivate={() => activate(ws.id)}
                  dragState={dragState}
                />
              ))}
            </div>
          </>
        )}

        <GroupHeader label={taskBound.length > 0 ? "Shells" : ""} />
        <div className="flex flex-col gap-0.5 px-0.5">
          {shells.map((ws) => (
            <RunspaceItem
              key={ws.id}
              ws={ws}
              onActivate={() => activate(ws.id)}
              dragState={dragState}
            />
          ))}
        </div>

        {detachedSessions.length > 0 && (
          <>
            <GroupHeader label="Detached" />
            <div className="flex flex-col gap-0.5 px-0.5">
              {detachedSessions.map((session) => (
                <DetachedSessionItem
                  key={session.id}
                  session={session}
                  onReattach={() => reattach(session)}
                  onTerminate={() => {
                    terminalTerminate(session.id)
                      .catch((e) => console.warn("terminate failed:", e))
                      .finally(() => void refreshSessions());
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {taskBound.some((s) => s.isActive) && (
        <div className="border-t border-border px-2.5 py-2">
          <button
            type="button"
            onClick={() => setSpace("work-board")}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <svg
              className="size-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to Board
          </button>
        </div>
      )}
    </div>
  );
}
