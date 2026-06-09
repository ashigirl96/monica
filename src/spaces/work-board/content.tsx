import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { columnTasksAtom, loadBoardAtom } from "@/stores/workboard";
import { TaskCard } from "./task-card";

function WorkBoardContent() {
  const columns = useAtomValue(columnTasksAtom);
  const loadBoard = useSetAtom(loadBoardAtom);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  return (
    <div className="flex h-full gap-px overflow-x-auto bg-border/30">
      {columns.map((col) => (
        <div
          key={col.key}
          className="flex min-w-72 flex-1 flex-col bg-background/50 first:rounded-l-lg last:rounded-r-lg"
        >
          <div className="flex items-center gap-2 px-3 py-2.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {col.label}
            </span>
            {col.tasks.length > 0 && (
              <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                {col.tasks.length}
              </span>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-3 scrollbar-hide">
            {col.tasks.length > 0 ? (
              col.tasks.map((task) => <TaskCard key={task.id} task={task} />)
            ) : (
              <div className="flex flex-1 items-start justify-center pt-12">
                <span className="text-[11px] text-muted-foreground/30">No tasks</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default WorkBoardContent;
