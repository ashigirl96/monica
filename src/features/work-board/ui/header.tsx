import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue } from "jotai";
import {
  createRawTaskMutationAtom,
  newTaskOpenAtom,
  projectFilterOpenAtom,
  selectedProjectAtom,
  trackIssueMutationAtom,
} from "@/stores/workboard";
import { projectsAtom } from "@/stores/projects";
import { ProjectPickerModal } from "@/components/project-picker-modal";
import { prSyncLastSyncedAtom } from "@/stores/pr-sync";
import { XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

const FOCUSABLE = "input:not(:disabled), select:not(:disabled), button:not(:disabled)";

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const projects = useAtomValue(projectsAtom);

  const [issueInput, setIssueInput] = useState("");
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: createTask, isPending: creating } = useAtomValue(createRawTaskMutationAtom);
  const { mutateAsync: trackIssue, isPending: tracking } = useAtomValue(trackIssueMutationAtom);
  const isPending = creating || tracking;

  const dialogRef = useRef<HTMLDivElement>(null);
  const issueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    requestAnimationFrame(() => issueRef.current?.focus());
  }, []);

  // The two paths are mutually exclusive: typing an issue link disables the raw fields and vice
  // versa, so only the relevant inputs stay in the tab order.
  const issueActive = issueInput.trim().length > 0;
  const rawActive = title.trim().length > 0;
  const canSubmit = issueActive || (rawActive && projectId !== "");

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || isPending) return;
    setError(null);
    try {
      if (issueActive) await trackIssue(issueInput.trim());
      else await createTask({ title: title.trim(), projectId });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create task");
    }
  }, [
    canSubmit,
    isPending,
    issueActive,
    issueInput,
    title,
    projectId,
    trackIssue,
    createTask,
    onClose,
  ]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
      return;
    }
    if (e.key === "Tab") {
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 duration-150"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="animate-in fade-in zoom-in-95 w-96 rounded-lg border border-border bg-popover p-4 shadow-xl duration-150"
      >
        <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          New Task
        </div>

        <div className="flex flex-col gap-3">
          <input
            ref={issueRef}
            type="text"
            value={issueInput}
            disabled={rawActive}
            onChange={(e) => {
              setIssueInput(e.target.value);
              setError(null);
            }}
            placeholder="owner/repo#123 or issue URL"
            className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/50 outline-none transition-opacity focus:border-muted-foreground/40 disabled:cursor-not-allowed disabled:opacity-40"
          />

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>

          <div
            className={cn("flex flex-col gap-2 transition-opacity", issueActive && "opacity-40")}
          >
            <select
              value={projectId}
              disabled={issueActive}
              onChange={(e) => {
                setProjectId(e.target.value);
                setError(null);
              }}
              className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-muted-foreground/40 disabled:cursor-not-allowed"
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={title}
              disabled={issueActive}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              placeholder="Task title"
              className="h-8 rounded-md border border-border bg-background px-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-muted-foreground/40 disabled:cursor-not-allowed"
            />
          </div>

          {error && <p className="text-[10px] text-red-400">{error}</p>}

          <div className="flex items-center justify-between border-t border-border/60 pt-3">
            <span className="text-[10px] text-muted-foreground/50">
              ⇥ move · ⏎ create · esc close
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || isPending}
              className="inline-flex h-7 items-center rounded-md bg-primary px-3 text-[11px] text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {isPending ? "..." : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NewTaskButton() {
  const [open, setOpen] = useAtom(newTaskOpenAtom);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New Task
      </button>
      {open && <NewTaskModal onClose={() => setOpen(false)} />}
    </>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function LastSyncedLabel() {
  const lastSyncAt = useAtomValue(prSyncLastSyncedAtom);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (lastSyncAt === null) return;
    const timer = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [lastSyncAt]);

  if (lastSyncAt === null) return null;

  const elapsed = Math.floor((Date.now() - lastSyncAt) / 1000);
  return (
    <span className="ml-auto text-[10px] text-muted-foreground/60">
      Synced {formatElapsed(elapsed)}
    </span>
  );
}

function ProjectFilterBadge() {
  const [open, setOpen] = useAtom(projectFilterOpenAtom);
  const [selected, setSelected] = useAtom(selectedProjectAtom);

  return (
    <>
      {selected !== null && (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-400">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="transition-colors hover:text-cyan-300"
          >
            {selected}
          </button>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="ml-0.5 text-cyan-400/60 transition-colors hover:text-cyan-300"
          >
            <XIcon size={12} />
          </button>
        </span>
      )}
      {open && <ProjectPickerModal onClose={() => setOpen(false)} onSelect={setSelected} />}
    </>
  );
}

export function WorkBoardHeader() {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <NewTaskButton />
      <ProjectFilterBadge />
      <LastSyncedLabel />
    </div>
  );
}
