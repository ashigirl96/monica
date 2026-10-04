import { ORPCError } from "@orpc/server";
import { agentSession, tab } from "@tania/workbench/schema";
import type { Db } from "@tania/workbench/server";
import { and, eq, type SQL } from "drizzle-orm";
import type { CurrentOutput } from "./contract.ts";
import { displayState } from "./display-state.ts";
import { taskLabel } from "./label.ts";
import { formatRef } from "./ref.ts";
import { liveAgentSession, runAgentSessionsByTask } from "./run.ts";
import { bench, issue, run, task } from "./schema.ts";

export function currentTask(db: Db, terminalSessionId: string | undefined): CurrentOutput {
  if (!terminalSessionId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "not in a Tab of the Workbench: TANIA_TERMINAL_SESSION_ID is not set",
    });
  }
  const byRun = taskOfRun(
    db,
    and(eq(agentSession.terminalSessionId, terminalSessionId), liveAgentSession),
  );
  const found = byRun ?? taskOfBench(db, terminalSessionId);
  if (!found) {
    throw new ORPCError("NOT_FOUND", {
      message: `Terminal Session ${terminalSessionId} runs no Run of a Task, and its Tab is not in a Bench`,
    });
  }
  const runsOf = runAgentSessionsByTask(db, [found.task.issueId]);
  return {
    ref: formatRef(found.issue),
    title: found.issue.title,
    displayState: displayState(found.task, found.issue, found.bench, runsOf(found.task.issueId)),
    agentSessionId: byRun?.agentSessionId ?? null,
    source: byRun ? "run" : "bench",
  };
}

// Bench の Tab で始まったばかりの Agent Session の Run は、購読の microtask が作るまでまだ無い。
export function nameAgentSession(db: Db, agentSessionId: string): string | null {
  const found =
    taskOfRun(db, eq(agentSession.sessionId, agentSessionId)) ??
    taskOfBenchHosting(db, agentSessionId);
  return found ? taskLabel(formatRef(found.issue), found.issue.title) : null;
}

function taskOfRun(db: Db, agentSessionMatches: SQL | undefined) {
  return db
    .select({ task, issue, bench, agentSessionId: agentSession.sessionId })
    .from(agentSession)
    .innerJoin(run, eq(run.agentSessionId, agentSession.sessionId))
    .innerJoin(task, eq(task.issueId, run.taskIssueId))
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(agentSessionMatches)
    .get();
}

function taskOfBench(db: Db, terminalSessionId: string) {
  return db
    .select({ task, issue, bench })
    .from(tab)
    .innerJoin(bench, eq(bench.runspaceId, tab.runspaceId))
    .innerJoin(task, eq(task.issueId, bench.taskIssueId))
    .innerJoin(issue, eq(issue.id, task.issueId))
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get();
}

function taskOfBenchHosting(db: Db, agentSessionId: string) {
  const host = db
    .select({ terminalSessionId: agentSession.terminalSessionId })
    .from(agentSession)
    .where(eq(agentSession.sessionId, agentSessionId))
    .get();
  return host ? taskOfBench(db, host.terminalSessionId) : undefined;
}
