import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  workboardListTasks,
  workboardRunTask,
  workboardTrackIssue,
  type TaskSummaryRow,
} from "@/commands/workboard";
import { ArrowRightIcon, XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { activeSpaceAtom } from "@/stores/space";
import {
  activateTaskRunspaceAtom,
  createTaskRunspaceAtom,
  loadTerminalStateAtom,
  saveTerminalStateAtom,
  taskRunspaceMapAtom,
  terminalReadyAtom,
} from "@/stores/terminal";
import {
  refreshWorkboardAtom,
  workboardRefreshNonceAtom,
  workboardSearchAtom,
  workboardTrackOpenAtom,
} from "@/stores/workboard";

type ColumnId = "inbox" | "ready" | "running" | "needs_you" | "interrupted" | "done";

const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "ready", label: "Ready" },
  { id: "running", label: "Running" },
  { id: "needs_you", label: "Needs You" },
  { id: "interrupted", label: "Interrupted" },
  { id: "done", label: "Done" },
];

const ACTIVE_RUN_STATUSES = new Set(["setting_up", "running", "waiting_for_user"]);

function columnFor(task: TaskSummaryRow): ColumnId {
  switch (task.status) {
    case "inbox":
      return "inbox";
    case "ready":
      return "ready";
    case "done":
      return "done";
    case "waiting_for_user":
      return "needs_you";
    case "stopped":
    case "failed":
      return "interrupted";
    default:
      return "running";
  }
}

function labelStatus(status: string | null | undefined): string {
  if (!status) return "not run";
  return status.replaceAll("_", " ");
}

function statusClass(status: string | null | undefined): string {
  switch (status) {
    case "waiting_for_user":
      return "border-amber-300/40 bg-amber-300/[0.12] text-amber-100";
    case "running":
    case "setting_up":
      return "border-emerald-300/35 bg-emerald-300/[0.12] text-emerald-100";
    case "failed":
    case "stopped":
      return "border-rose-300/40 bg-rose-300/[0.12] text-rose-100";
    case "ready":
      return "border-sky-300/35 bg-sky-300/[0.12] text-sky-100";
    default:
      return "border-white/[0.08] bg-white/[0.05] text-muted-foreground";
  }
}

function prLabel(task: TaskSummaryRow): string | null {
  const pr = task.github_pull_requests[0];
  if (!pr || pr.number === null) return null;
  return `PR #${pr.number}${pr.status ? ` ${pr.status}` : ""}`;
}

function issueLabel(task: TaskSummaryRow): string | null {
  return task.github_issue_number ? `GitHub #${task.github_issue_number}` : null;
}

function bodyPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export default function WorkBoardContent() {
  const [tasks, setTasks] = useState<TaskSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [trackInput, setTrackInput] = useState("");
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackOpen, setTrackOpen] = useAtom(workboardTrackOpenAtom);
  const search = useAtomValue(workboardSearchAtom);
  const refreshNonce = useAtomValue(workboardRefreshNonceAtom);
  const terminalReady = useAtomValue(terminalReadyAtom);
  const runspaceMap = useAtomValue(taskRunspaceMapAtom);
  const loadTerminalState = useSetAtom(loadTerminalStateAtom);
  const saveTerminalState = useSetAtom(saveTerminalStateAtom);
  const createTaskRunspace = useSetAtom(createTaskRunspaceAtom);
  const activateTaskRunspace = useSetAtom(activateTaskRunspaceAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
  const refresh = useSetAtom(refreshWorkboardAtom);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await workboardListTasks());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!terminalReady) loadTerminalState();
  }, [terminalReady, loadTerminalState]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks, refreshNonce]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((task) =>
      [task.id, task.title, task.project ?? "", task.branch ?? "", issueLabel(task) ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [tasks, search]);

  const activeRuns = visibleTasks.filter((task) =>
    ACTIVE_RUN_STATUSES.has(task.task_run_status ?? ""),
  );

  const grouped = useMemo(() => {
    const map = new Map<ColumnId, TaskSummaryRow[]>();
    for (const column of COLUMNS) map.set(column.id, []);
    for (const task of visibleTasks) {
      map.get(columnFor(task))?.push(task);
    }
    return map;
  }, [visibleTasks]);

  const openBench = useCallback(
    (task: TaskSummaryRow) => {
      const existingId = activateTaskRunspace({
        taskRunId: task.task_run_id,
        taskId: task.id,
      });
      if (!existingId && task.task_run_id && task.worktree_path) {
        createTaskRunspace({
          taskId: task.id,
          taskRunId: task.task_run_id,
          taskTitle: task.title,
          worktreePath: task.worktree_path,
          launch: null,
          activate: true,
        });
      }
      saveTerminalState();
      setActiveSpace("work-bench");
    },
    [activateTaskRunspace, createTaskRunspace, saveTerminalState, setActiveSpace],
  );

  const startRun = useCallback(
    async (task: TaskSummaryRow, openAfterStart: boolean) => {
      setBusyId(task.id);
      setError(null);
      try {
        const report = await workboardRunTask(task.id);
        createTaskRunspace({
          taskId: report.task_id,
          taskRunId: report.task_run_id,
          taskTitle: task.title,
          worktreePath: report.worktree_path,
          launch: report.launch,
          activate: openAfterStart,
        });
        saveTerminalState();
        refresh();
        if (openAfterStart) setActiveSpace("work-bench");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [createTaskRunspace, refresh, saveTerminalState, setActiveSpace],
  );

  const submitTrack = useCallback(
    async (mode: "track" | "open") => {
      const target = trackInput.trim();
      if (!target) return;
      setTrackBusy(true);
      setTrackError(null);
      try {
        const task = await workboardTrackIssue(target);
        setTrackOpen(false);
        setTrackInput("");
        refresh();
        if (mode !== "track") await startRun(task, true);
      } catch (e) {
        setTrackError(e instanceof Error ? e.message : String(e));
      } finally {
        setTrackBusy(false);
      }
    },
    [refresh, setTrackOpen, startRun, trackInput],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#202224] text-foreground">
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-white/[0.07] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Active Runs</div>
            <div className="truncate text-xs text-muted-foreground">
              {activeRuns.length === 0 ? "No active task runs" : `${activeRuns.length} running`}
            </div>
          </div>
        </div>
        <div className="scrollbar-hide flex gap-2 overflow-x-auto">
          {activeRuns.length === 0 ? (
            <div className="flex h-12 min-w-[260px] items-center rounded-lg border border-dashed border-white/[0.1] px-3 text-xs text-muted-foreground">
              Ready when you are.
            </div>
          ) : (
            activeRuns.map((task) => (
              <button
                key={task.id}
                onClick={() => openBench(task)}
                className={cn(
                  "flex h-12 min-w-[260px] max-w-[320px] items-center gap-3 rounded-lg border px-3 text-left transition-colors hover:bg-white/[0.08]",
                  statusClass(task.task_run_status),
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold">
                    {task.id} · {labelStatus(task.task_run_status)}
                  </div>
                  <div className="truncate text-[11px] opacity-80">
                    {task.task_run_wait_reason
                      ? labelStatus(task.task_run_wait_reason)
                      : (task.project ?? task.branch ?? "Workbench")}
                  </div>
                </div>
                <ArrowRightIcon size={14} />
              </button>
            ))
          )}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-xs text-rose-100">
          {error}
        </div>
      )}

      <div className="scrollbar-hide grid min-h-0 flex-1 grid-cols-[repeat(6,minmax(220px,1fr))] gap-3 overflow-x-auto overflow-y-hidden p-4">
        {COLUMNS.map((column) => {
          const items = grouped.get(column.id) ?? [];
          return (
            <section key={column.id} className="flex min-h-0 min-w-[220px] flex-col">
              <div className="mb-2 flex h-7 items-center justify-between px-1">
                <span className="text-xs font-semibold text-foreground">{column.label}</span>
                <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {items.length}
                </span>
              </div>
              <div className="scrollbar-hide flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    bound={!!(task.task_run_id && runspaceMap.has(task.task_run_id))}
                    busy={busyId === task.id}
                    onRun={() => startRun(task, true)}
                    onOpenBench={() => openBench(task)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/20 text-xs text-muted-foreground">
          Loading
        </div>
      )}

      {trackOpen && (
        <TrackIssueDialog
          target={trackInput}
          busy={trackBusy}
          error={trackError}
          onChange={setTrackInput}
          onClose={() => {
            setTrackOpen(false);
            setTrackError(null);
          }}
          onSubmit={submitTrack}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  bound,
  busy,
  onRun,
  onOpenBench,
}: {
  task: TaskSummaryRow;
  bound: boolean;
  busy: boolean;
  onRun: () => void;
  onOpenBench: () => void;
}) {
  const preview = bodyPreview(task.body);
  const issue = issueLabel(task);
  const pr = prLabel(task);
  const hasRunspaceTarget = !!task.task_run_id && !!task.worktree_path;
  return (
    <article className="rounded-lg border border-white/[0.08] bg-white/[0.045] p-3 shadow-sm transition-colors hover:bg-white/[0.065]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-muted-foreground">{task.id}</div>
          <h3 className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
            {task.title}
          </h3>
        </div>
        <span
          className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", statusClass(task.status))}
        >
          {labelStatus(task.status)}
        </span>
      </div>

      {preview && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{preview}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
        {task.project && (
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">{task.project}</span>
        )}
        {issue && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">{issue}</span>}
        {task.branch && (
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">{task.branch}</span>
        )}
        {pr && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">{pr}</span>}
      </div>

      <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/10 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">Run</span>
          <span className="truncate text-foreground">
            {task.task_run_id
              ? `${labelStatus(task.task_run_status)} · ${task.task_run_id}`
              : "Ready to run"}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">Workbench</span>
          <span className={bound ? "text-emerald-100" : "text-muted-foreground"}>
            {bound ? "bound" : hasRunspaceTarget ? "openable" : "unbound"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex gap-1.5">
        {hasRunspaceTarget ? (
          <button
            onClick={onOpenBench}
            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-white/[0.09] text-xs font-medium transition-colors hover:bg-white/[0.13]"
          >
            <ArrowRightIcon size={13} />
            Open Bench
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={onRun}
            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-foreground text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <ArrowRightIcon size={13} />
            Run & Open
          </button>
        )}
      </div>
    </article>
  );
}

function TrackIssueDialog({
  target,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  target: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (mode: "track" | "open") => void;
}) {
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit("track");
  }

  return (
    <div className="absolute inset-0 z-10 flex items-start justify-center bg-black/40 px-4 pt-16">
      <form
        onSubmit={submit}
        className="w-full max-w-[520px] rounded-lg border border-white/[0.1] bg-[#242628] p-4 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Track Issue</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          >
            <XIcon size={14} />
          </button>
        </div>
        <input
          autoFocus
          value={target}
          onChange={(e) => onChange(e.target.value)}
          placeholder="owner/repo#123 or GitHub issue URL"
          className="mt-4 h-9 w-full rounded-md border border-white/[0.1] bg-white/[0.06] px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-white/[0.22]"
        />
        {error && (
          <div className="mt-3 rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-xs text-rose-100">
            {error}
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            disabled={busy || !target.trim()}
            type="submit"
            className="h-8 rounded-md bg-white/[0.08] text-xs font-medium hover:bg-white/[0.12] disabled:opacity-50"
          >
            Track only
          </button>
          <button
            disabled={busy || !target.trim()}
            type="button"
            onClick={() => onSubmit("open")}
            className="h-8 rounded-md bg-foreground text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            Track & Open
          </button>
        </div>
      </form>
    </div>
  );
}
