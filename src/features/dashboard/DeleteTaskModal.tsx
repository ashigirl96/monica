import { Trash2, X } from "lucide-react";
import type { TaskView } from "./types";

interface DeleteTaskModalProps {
  item: TaskView | null;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteTaskModal({
  item,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DeleteTaskModalProps) {
  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-task-title"
        className="w-full max-w-sm rounded-lg border border-border/70 bg-card shadow-2xl"
      >
        <header className="border-b border-border/50 px-5 py-4">
          <h2 id="delete-task-title" className="text-[15px] font-medium text-foreground">
            削除しますか
          </h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {item.id} / {item.title}
          </p>
        </header>

        {error && (
          <div className="mx-5 mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed text-destructive">
            {error}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-3.5" />
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            autoFocus
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="size-3.5" />
            {deleting ? "Deleting" : "Delete"}
          </button>
        </footer>
      </section>
    </div>
  );
}
