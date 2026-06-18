import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  createRawTaskMutationAtom,
  newTaskOpenAtom,
  projectsAtom,
  trackIssueMutationAtom,
} from "@/stores/workboard";
import { prSyncLastSyncedAtom } from "@/stores/pr-sync";
import { PopoverMenu, type PopoverAnchor } from "@/components/popover-menu";
import { cn } from "@/lib/utils";

type Mode = "raw" | "issue";

function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="relative grid grid-cols-2 rounded-md border border-border bg-secondary p-0.5 text-[11px]">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[5px] bg-background shadow-sm transition-transform duration-150 ease-out",
          mode === "raw" && "translate-x-full",
        )}
      />
      {(["issue", "raw"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "relative z-10 rounded-[5px] py-1 transition-colors",
            mode === m ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "raw" ? "Raw" : "From Issue"}
        </button>
      ))}
    </div>
  );
}

function NewTaskPopover({ anchor, onClose }: { anchor: PopoverAnchor; onClose: () => void }) {
  const projects = useAtomValue(projectsAtom);

  const [mode, setMode] = useState<Mode>("raw");
  const [title, setTitle] = useState("");
  const [issueInput, setIssueInput] = useState("");
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const { mutateAsync: createTask, isPending: creating } = useAtomValue(createRawTaskMutationAtom);
  const { mutateAsync: trackIssue, isPending: tracking } = useAtomValue(trackIssueMutationAtom);
  const isPending = creating || tracking;

  const titleRef = useRef<HTMLInputElement>(null);
  const issueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    setError(null);
    requestAnimationFrame(() => {
      if (mode === "raw") titleRef.current?.focus();
      else issueRef.current?.focus();
    });
  }, [mode]);

  const canSubmit =
    mode === "raw" ? title.trim().length > 0 && projectId !== "" : issueInput.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || isPending) return;
    setError(null);
    try {
      if (mode === "raw") await createTask({ title: title.trim(), projectId });
      else await trackIssue(issueInput.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create task");
    }
  }, [canSubmit, isPending, mode, title, projectId, issueInput, createTask, trackIssue, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setMode((m) => (m === "raw" ? "issue" : "raw"));
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <PopoverMenu anchor={anchor} onClose={onClose} className="w-80 p-3">
      <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
        <ModeTabs mode={mode} onChange={setMode} />

        {mode === "raw" ? (
          <div className="flex flex-col gap-2">
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setError(null);
              }}
              className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-muted-foreground/40"
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              placeholder="Task title"
              className="h-8 rounded-md border border-border bg-background px-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-muted-foreground/40"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              ref={issueRef}
              type="text"
              value={issueInput}
              onChange={(e) => {
                setIssueInput(e.target.value);
                setError(null);
              }}
              placeholder="owner/repo#123 or issue URL"
              className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-muted-foreground/40"
            />
            <p className="text-[10px] text-muted-foreground/70">
              タイトルは issue から取り込まれます
            </p>
          </div>
        )}

        {error && <p className="text-[10px] text-red-400">{error}</p>}

        <div className="flex items-center justify-between border-t border-border/60 pt-2.5">
          <span className="text-[10px] text-muted-foreground/50">
            ⇥ switch · ⏎ create · esc close
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
    </PopoverMenu>
  );
}

function NewTaskButton() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useAtom(newTaskOpenAtom);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  useEffect(() => {
    if (open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, left: r.left });
    } else {
      setAnchor(null);
    }
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
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
      {open && anchor && <NewTaskPopover anchor={anchor} onClose={() => setOpen(false)} />}
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

export function WorkBoardHeader() {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <NewTaskButton />
      <LastSyncedLabel />
    </div>
  );
}
