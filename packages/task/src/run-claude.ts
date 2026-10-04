import { existsSync } from "node:fs";
import { ORPCError, type ORPCErrorConstructorMap } from "@orpc/server";
import { agentSession } from "@tania/workbench/schema";
import type { Db } from "@tania/workbench/server";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  type Bench,
  type BenchDeps,
  type Issue,
  prepareBench,
  refuseClosing,
  refuseInPlace,
} from "./bench.ts";
import type { RunOutput, runErrors } from "./contract.ts";
import { isIssue, openBlockersOf } from "./copy.ts";
import { findOpenTask } from "./open-task.ts";
import { formatRef, parseRef } from "./ref.ts";
import { runAgentSessionsByTask } from "./run.ts";
import { issue, run } from "./schema.ts";
import { type SyncDeps, syncOrUseCopy } from "./sync.ts";

// 表示されていない Tab の shell は決まった大きさで起こし、attach の resize で追いつかせる。
const TAB_SIZE = { rows: 24, cols: 80 };

type Launch = {
  ref: string;
  bench: Bench;
  benchCreated: boolean;
  warnings: string[];
  tabCwd: string;
  resumed: string | null;
};

export async function runTask(
  deps: SyncDeps & BenchDeps,
  input: { ref: string; inPlace?: boolean; force?: boolean },
  errors: ORPCErrorConstructorMap<typeof runErrors>,
): Promise<RunOutput> {
  const asked = parseRef(input.ref);
  const found = findOpenTask(deps.db, isIssue(asked), formatRef(asked));
  if (found.bench) {
    refuseInPlace(found.bench, input.inPlace, formatRef(found.issue));
    refuseLiveRuns(deps.db, found.issue);
  }
  const launch =
    (found.bench && resumeOf(deps.db, found.issue, found.bench)) ??
    (await newRun(deps, found.issue, input, errors));
  const opened = await openClaudeTab(deps, launch);
  return {
    ref: launch.ref,
    cwd: launch.bench.cwd,
    mode: launch.bench.mode,
    benchCreated: launch.benchCreated,
    warnings: launch.warnings,
    ...opened,
    resumed: launch.resumed,
  };
}

function refuseLiveRuns(db: Db, forIssue: Issue) {
  const live = runAgentSessionsByTask(db, [forIssue.id])(forIssue.id);
  if (live.length === 0) return;
  const states = live.map(
    (r) => `${r.sessionId} ${r.state === "waiting" ? `waiting:${r.waitReason}` : r.state}`,
  );
  throw new ORPCError("CONFLICT", {
    message: `${formatRef(forIssue)} has ${live.length === 1 ? "a live Run" : "live Runs"} (${states.join(", ")}); to add an agent alongside, open a Tab in its Bench and run claude there`,
  });
}

// Bench より前の Run は reopen の前の挑戦で、transcript の無い claude（最初の prompt まで書かない）は --resume が会話を見つけられないので、どちらも候補にしない。
function resumeOf(db: Db, forIssue: Issue, row: Bench): Launch | null {
  const last = db
    .select({
      agentSessionId: agentSession.sessionId,
      cwd: agentSession.cwd,
      transcriptPath: agentSession.transcriptPath,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(and(eq(run.taskIssueId, forIssue.id), gte(run.startedAt, row.createdAt)))
    .orderBy(desc(agentSession.lastEventAt), desc(run.id))
    .all()
    .find(({ transcriptPath }) => transcriptPath === null || existsSync(transcriptPath));
  if (!last) return null;
  return {
    ref: formatRef(forIssue),
    bench: row,
    benchCreated: false,
    warnings: [],
    tabCwd: existsSync(last.cwd) ? last.cwd : row.cwd,
    resumed: last.agentSessionId,
  };
}

async function newRun(
  deps: SyncDeps & BenchDeps,
  forIssue: Issue,
  { inPlace, force }: { inPlace?: boolean; force?: boolean },
  errors: ORPCErrorConstructorMap<typeof runErrors>,
): Promise<Launch> {
  const syncWarnings = await syncOrUseCopy(deps, forIssue);
  // sync は repo の改名を写すので、名前でなく行の id で引き直す。
  const synced = findOpenTask(deps.db, eq(issue.id, forIssue.id), formatRef(forIssue));
  const ref = formatRef(synced.issue);
  if (!force) {
    const blockers = openBlockersOf(deps.db, [synced.issue.id]).map(formatRef);
    if (blockers.length > 0) {
      throw errors.BLOCKED({
        message: `${ref} is blocked by ${blockers.join(", ")}; pass --force to start a Run anyway`,
        data: { blockers },
      });
    }
  }
  const prepared = await prepareBench(deps, synced, inPlace);
  return {
    ref,
    bench: prepared.bench,
    benchCreated: prepared.created,
    warnings: [...syncWarnings, ...prepared.warnings],
    tabCwd: prepared.bench.cwd,
    resumed: null,
  };
}

async function openClaudeTab(deps: BenchDeps, launch: Launch) {
  const { db, workbench } = deps;
  await workbench.ready();
  const opened = db.transaction((tx) => {
    refuseClosing(deps, launch.bench.taskIssueId, launch.ref);
    return workbench.openTab(tx, { runspaceId: launch.bench.runspaceId, cwd: launch.tabCwd });
  });
  await workbench.startTerminalSession(opened.terminalSessionId, TAB_SIZE);
  // 起動前の shell に書いた入力も捨てられずに評価されるので、起動を待たない。
  await workbench.writeTerminalSession(opened.terminalSessionId, `${claudeCommand(launch)}\r`);
  return opened;
}

// Agent Session の id は hook の payload から来るので、shell に解釈させない。
function claudeCommand({ resumed }: Launch): string {
  return resumed === null ? "claude" : `claude --resume '${resumed.replaceAll("'", `'\\''`)}'`;
}
