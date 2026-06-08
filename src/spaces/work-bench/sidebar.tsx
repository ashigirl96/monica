import { useAtomValue, useSetAtom } from "jotai";
import {
  runspaceSummariesAtom,
  activateRunspaceAtom,
  reorderRunspacesAtom,
} from "@/stores/terminal";
import { cn } from "@/lib/utils";
import { useRef, useState } from "react";

export function WorkBenchSidebar() {
  const summaries = useAtomValue(runspaceSummariesAtom);
  const activate = useSetAtom(activateRunspaceAtom);
  const reorder = useSetAtom(reorderRunspacesAtom);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  return (
    <div className="flex flex-col gap-0.5">
      {summaries.map((ws) => (
        <button
          key={ws.id}
          draggable
          onDragStart={() => {
            dragIdRef.current = ws.id;
          }}
          onDragEnd={() => {
            dragIdRef.current = null;
            setDragOverId(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverId(ws.id);
          }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverId(null);
            if (dragIdRef.current && dragIdRef.current !== ws.id) {
              reorder(dragIdRef.current, ws.id);
            }
            dragIdRef.current = null;
          }}
          onPointerDown={() => activate(ws.id)}
          className={cn(
            "flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left",
            "transition-colors duration-100",
            ws.isActive
              ? "bg-white/[0.1] text-foreground"
              : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
            dragOverId === ws.id && "ring-1 ring-white/20",
          )}
        >
          <span className="truncate text-xs font-medium">{ws.title || "Terminal"}</span>
          {ws.description && (
            <span className="truncate text-[10px] text-muted-foreground">{ws.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}
