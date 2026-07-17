import { lazy, Suspense, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { PreviewDialog, PreviewDialogLoading } from "@/components/preview-dialog";
import { readTaskMemo } from "@/commands/task";
import { pendingTaskMemoWrites } from "@/features/task-memo/save-queue";
import { activeSpaceAtom } from "@/stores/space";
import { taskMemoAtom } from "@/features/task-memo/store";

// Lazy so @milkdown/* stays out of the startup bundle and loads on first alt+M.
const MemoEditor = lazy(() => import("@/features/task-memo/ui/memo-editor"));

export function TaskMemoModal() {
  const [taskId, setTaskId] = useAtom(taskMemoAtom);
  const activeSpace = useAtomValue(activeSpaceAtom);
  const [initialValue, setInitialValue] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setInitialValue(null);
      return;
    }
    // warm the milkdown chunk while the memo IPC round-trip is in flight
    void import("@/features/task-memo/ui/memo-editor");
    let cancelled = false;
    // a just-closed editor may still be flushing this task's memo; read after it lands
    void pendingTaskMemoWrites(taskId)
      .then(() => readTaskMemo(taskId))
      .then((md) => {
        if (!cancelled) setInitialValue(md);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Close on any space switch so the memo can't linger over another space, and so the
  // open memo always matches the space it was resolved from (unmount flushes). The modal
  // stays mounted while closed, so this effect never fires right after an open.
  useEffect(() => {
    setTaskId(null);
  }, [activeSpace, setTaskId]);

  if (!taskId) return null;
  const close = () => setTaskId(null);

  return (
    <PreviewDialog
      label="Memo"
      title={taskId}
      closeLabel="Close task memo"
      onClose={close}
      onDialogKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        // don't let the global handler also act on this Escape (e.g. close a plan
        // preview layered underneath)
        e.stopPropagation();
        close();
      }}
      bodyClassName="select-text"
    >
      {initialValue === null ? (
        <PreviewDialogLoading />
      ) : (
        <Suspense fallback={<PreviewDialogLoading />}>
          <MemoEditor key={taskId} taskId={taskId} initialValue={initialValue} />
        </Suspense>
      )}
    </PreviewDialog>
  );
}
