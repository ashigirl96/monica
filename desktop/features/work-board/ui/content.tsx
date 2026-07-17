import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useBoardNavigation } from "@/features/work-board/use-board-navigation";
import { boardViewAtom, columnTasksAtom, loadBoardAtom } from "@/stores/workboard";
import { applyRestoredWorkboardAtom, focusedTaskIdAtom } from "@/features/work-board/nav";
import { BoardContextMenu } from "./board-context-menu";
import { TaskCard } from "./task-card";

function TasksView() {
  const columns = useAtomValue(columnTasksAtom);
  const focusedTaskId = useAtomValue(focusedTaskIdAtom);
  const loadBoard = useSetAtom(loadBoardAtom);
  const applyRestored = useSetAtom(applyRestoredWorkboardAtom);

  useBoardNavigation();

  useEffect(() => {
    loadBoard().then(() => applyRestored());
  }, [loadBoard, applyRestored]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 gap-px overflow-x-auto bg-border/30">
        {columns.map((col) => (
          <div
            key={col.key}
            className="flex min-h-0 min-w-72 flex-1 flex-col bg-background/50 first:rounded-l-lg last:rounded-r-lg"
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
                col.tasks.map((task) => (
                  <TaskCard key={task.id} task={task} focused={task.id === focusedTaskId} />
                ))
              ) : (
                <div className="flex flex-1 items-start justify-center pt-12">
                  <span className="text-[11px] text-muted-foreground/30">No tasks</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {focusedTaskId !== null && <HintBar />}
      <BoardContextMenu />
    </div>
  );
}

function IntentsView() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-sm text-muted-foreground/30">Intents — coming soon</span>
    </div>
  );
}

function HintBar() {
  return (
    <div className="flex h-6 shrink-0 items-center justify-center gap-4 font-mono text-[10px] text-muted-foreground/50">
      <span>j/k move</span>
      <span>h/l column</span>
      <span>space menu</span>
      <span>p prepare</span>
      <span>r run</span>
      <span>b bench</span>
      <span>esc exit</span>
    </div>
  );
}

function WorkBoardContent() {
  const view = useAtomValue(boardViewAtom);
  return view === "tasks" ? <TasksView /> : <IntentsView />;
}

export default WorkBoardContent;
