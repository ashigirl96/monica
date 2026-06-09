import { useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  runspaceSummariesAtom,
  activateRunspaceAtom,
  reorderRunspacesAtom,
  type RunspaceSummary,
} from "@/stores/terminal";
import { activeSpaceAtom } from "@/stores/space";
import { cn } from "@/lib/utils";

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
        ws.isActive
          ? "bg-white/[0.1] text-foreground"
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
  const activate = useSetAtom(activateRunspaceAtom);
  const reorder = useSetAtom(reorderRunspacesAtom);
  const setSpace = useSetAtom(activeSpaceAtom);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

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
