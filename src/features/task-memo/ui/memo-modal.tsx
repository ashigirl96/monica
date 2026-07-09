import { lazy, Suspense, useEffect, useState } from "react";
import { useAtom } from "jotai";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { readTaskMemo } from "@/commands/task";
import { taskMemoAtom } from "@/features/task-memo/store";

// Lazy so @milkdown/* stays out of the startup bundle and loads on first cmd+I.
const MemoEditor = lazy(() => import("@/features/task-memo/ui/memo-editor"));

export function TaskMemoModal() {
  const [memo, setMemo] = useAtom(taskMemoAtom);
  const [initialValue, setInitialValue] = useState<string | null>(null);
  const taskId = memo?.taskId ?? null;

  useEffect(() => {
    if (!taskId) {
      setInitialValue(null);
      return;
    }
    let cancelled = false;
    void readTaskMemo(taskId).then((md) => {
      if (!cancelled) setInitialValue(md);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // The editor grabs focus itself, which keeps typed keys, paste and IME out of the
  // xterm behind the overlay; on close hand focus back to whatever held it.
  useEffect(() => {
    if (!taskId) return;
    const restoreFocus = document.activeElement as HTMLElement | null;
    return () => restoreFocus?.focus?.();
  }, [taskId]);

  if (!taskId) return null;
  const close = () => setMemo(null);

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-[6vh] backdrop-blur-sm duration-150"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        className="animate-in zoom-in-95 flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none duration-150"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/70">
            Memo
          </span>
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{taskId}</span>
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
          <button
            type="button"
            onClick={close}
            aria-label="Close task memo"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </header>
        <div className="select-text overflow-y-auto px-6 py-5">
          {initialValue === null ? (
            <div className="py-2 text-xs text-muted-foreground/40">Loading…</div>
          ) : (
            <Suspense
              fallback={<div className="py-2 text-xs text-muted-foreground/40">Loading…</div>}
            >
              <MemoEditor key={taskId} taskId={taskId} initialValue={initialValue} />
            </Suspense>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
