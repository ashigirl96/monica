import { useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  runspaceSummariesAtom,
  activateRunspaceAtom,
  detachedSessionsAtom,
  jumpHintTargetsAtom,
  reattachSessionAtom,
  refreshSessionsAtom,
  reorderRunspacesAtom,
  type RunspaceSummary,
} from "@/features/work-bench/store";
import { JumpHint } from "./jump-hint";
import { terminalTerminate, type TerminalSession } from "@/commands/terminal";
import type { DisplayStatus } from "@/commands/task";
import { taskStatusMapAtom } from "@/stores/workboard";
import { activeSpaceAtom } from "@/stores/space";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { shortPath } from "@/lib/paths";
import { cn } from "@/lib/utils";

const TASK_STATUS_DOT: Partial<Record<DisplayStatus, string>> = {
  setting_up: "bg-blue-400 animate-pulse",
  prepared: "bg-cyan-400",
  running: "bg-emerald-400 animate-pulse",
  waiting_for_user: "bg-amber-400",
  stopped: "bg-muted-foreground/50",
  failed: "bg-red-400",
};

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
  dragHandlers,
  isDragOver,
  status,
  hint,
}: {
  ws: RunspaceSummary;
  onActivate: () => void;
  dragHandlers: React.HTMLAttributes<HTMLButtonElement> & { draggable: boolean };
  isDragOver: boolean;
  status?: DisplayStatus;
  hint?: string;
}) {
  return (
    <button
      {...dragHandlers}
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
        isDragOver && "ring-1 ring-white/20",
      )}
    >
      <div className="flex items-center gap-1.5">
        {hint && <JumpHint hint={hint} ctrl />}
        {ws.taskId && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-px font-mono text-[9px] text-emerald-400">
            {ws.taskId}
          </span>
        )}
        <span className="flex-1 truncate text-xs font-medium">{ws.title || "Terminal"}</span>
        {status && TASK_STATUS_DOT[status] && (
          <span
            title={status.replace(/_/g, " ")}
            className={cn("size-1.5 shrink-0 rounded-full", TASK_STATUS_DOT[status])}
          />
        )}
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
  const taskStatusMap = useAtomValue(taskStatusMapAtom);
  const activate = useSetAtom(activateRunspaceAtom);
  const reattach = useSetAtom(reattachSessionAtom);
  const refreshSessions = useSetAtom(refreshSessionsAtom);
  const reorder = useSetAtom(reorderRunspacesAtom);
  const setSpace = useSetAtom(activeSpaceAtom);
  const jumpHints = useAtomValue(jumpHintTargetsAtom);
  const { dragOverId, handlersFor } = useDragReorder(reorder);

  // Session status lives in the DB and the daemon; like the primary-tab indicator it has
  // no push channel for every change, so poll while visible. Task status is refreshed
  // app-wide on backend events, so only sessions need polling here.
  useLiveRefresh(refreshSessions);

  const { taskBound, shells } = useMemo(() => {
    const taskBound = summaries.filter((s) => s.taskId);
    const shells = summaries.filter((s) => !s.taskId);
    return { taskBound, shells };
  }, [summaries]);

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
                  dragHandlers={handlersFor(ws.id)}
                  isDragOver={dragOverId === ws.id}
                  status={ws.taskId ? taskStatusMap[ws.taskId] : undefined}
                  hint={jumpHints.byRunspaceId[ws.id]}
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
              dragHandlers={handlersFor(ws.id)}
              isDragOver={dragOverId === ws.id}
              hint={jumpHints.byRunspaceId[ws.id]}
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
