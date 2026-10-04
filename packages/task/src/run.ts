import { agentSession, tab } from "@tania/workbench/schema";
import type { Db } from "@tania/workbench/server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { RunAgentSession } from "./display-state.ts";
import { bench, run } from "./schema.ts";

export const liveAgentSession = ne(agentSession.state, "ended");

// Run になっている Agent Session は当て直さないので、Tab がどこへ移っても終わるまで元の Task の Run のまま。
export function applyRunInvariant(db: Db, agentSessionId?: string) {
  db.transaction((tx) => {
    const orphans = tx
      .select({ agentSessionId: agentSession.sessionId, taskIssueId: bench.taskIssueId })
      .from(agentSession)
      .innerJoin(tab, eq(tab.terminalSessionId, agentSession.terminalSessionId))
      .innerJoin(bench, eq(bench.runspaceId, tab.runspaceId))
      .leftJoin(run, eq(run.agentSessionId, agentSession.sessionId))
      .where(
        and(
          liveAgentSession,
          isNull(run.id),
          agentSessionId === undefined ? undefined : eq(agentSession.sessionId, agentSessionId),
        ),
      )
      .all();
    if (orphans.length === 0) return;
    const startedAt = new Date();
    tx.insert(run)
      .values(orphans.map((orphan) => ({ ...orphan, origin: "started" as const, startedAt })))
      .run();
  });
}

export function runAgentSessionsByTask(db: Db, taskIssueIds: number[]) {
  const rows = db
    .select({
      taskIssueId: run.taskIssueId,
      sessionId: agentSession.sessionId,
      state: agentSession.state,
      waitReason: agentSession.waitReason,
      waitTool: agentSession.waitTool,
      errorType: agentSession.errorType,
      stateChangedAt: agentSession.stateChangedAt,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(and(inArray(run.taskIssueId, taskIssueIds), liveAgentSession))
    .all();
  const byTask = new Map<number, RunAgentSession[]>();
  for (const { taskIssueId, ...row } of rows) {
    byTask.set(taskIssueId, [...(byTask.get(taskIssueId) ?? []), row]);
  }
  return (taskIssueId: number) => byTask.get(taskIssueId) ?? [];
}
