import { useAtomValue } from "jotai";
import { boardViewAtom, columnTasksAtom } from "@/stores/workboard";
import { STATUS_COLORS } from "@/lib/status-config";
import { cn } from "@/lib/utils";

const COLUMN_DOT_COLOR: Record<string, string> = {
  ready: STATUS_COLORS.ready,
  "needs-you": STATUS_COLORS.waiting_for_user,
  running: STATUS_COLORS.running,
  interrupted: STATUS_COLORS.stopped,
};

export function WorkBoardSidebar() {
  const activeView = useAtomValue(boardViewAtom);
  const columns = useAtomValue(columnTasksAtom);

  return (
    <div className="flex h-full flex-col gap-0.5">
      <div
        className={cn(
          "rounded-lg px-2.5 py-1.5",
          activeView === "tasks" ? "bg-white/[0.1] text-foreground" : "text-muted-foreground",
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wider text-muted-foreground/50 uppercase">
            Tasks
          </span>
          <div className="flex items-center gap-2.5">
            {columns.map((col) => (
              <div key={col.key} className="flex items-center gap-1">
                <span className={cn("size-2 shrink-0 rounded-full", COLUMN_DOT_COLOR[col.key])} />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {col.tasks.length}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "rounded-lg px-2.5 py-1.5",
          activeView === "intents" ? "bg-white/[0.1] text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="text-xs font-semibold tracking-wider text-muted-foreground/50 uppercase">
          Intents
        </span>
      </div>
    </div>
  );
}
