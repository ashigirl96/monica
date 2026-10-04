import { existsSync } from "node:fs";
import { ORPCError } from "@orpc/server";
import { agentSession, tab } from "@tania/workbench/schema";
import { and, eq } from "drizzle-orm";
import { type BenchDeps, insertBench } from "./bench.ts";
import type { AttachOutput } from "./contract.ts";
import { isIssue } from "./copy.ts";
import { callerTerminalSession } from "./current.ts";
import { findOpenTask } from "./open-task.ts";
import { checkoutOf, messageOf } from "./prepare.ts";
import { formatRef, parseRef } from "./ref.ts";
import { insertRuns, liveAgentSession } from "./run.ts";
import { issue, run } from "./schema.ts";

type Checkout = { path: string } | { missing: string };

export async function attachTab(
  deps: BenchDeps,
  input: { ref: string; terminalSessionId?: string },
): Promise<AttachOutput> {
  const { db, workbench } = deps;
  const terminalSessionId = callerTerminalSession(input.terminalSessionId);
  const asked = parseRef(input.ref);
  const requested = findOpenTask(db, isIssue(asked), formatRef(asked));
  // ghq root は async なので transaction の前に引き、その間に run が Bench を作っていればそちらを使う。
  const checkout = requested.bench ? null : await checkoutOnDisk(deps, requested.issue);
  const attached = db.transaction((tx): AttachOutput & { moved: boolean } => {
    const callerTab = tx
      .select({ id: tab.id, runspaceId: tab.runspaceId })
      .from(tab)
      .where(eq(tab.terminalSessionId, terminalSessionId))
      .get();
    if (!callerTab) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Terminal Session ${terminalSessionId} is in no Tab; reattach it to a Tab first`,
      });
    }
    const found = findOpenTask(tx, eq(issue.id, requested.issue.id), formatRef(requested.issue));
    const ref = formatRef(found.issue);
    const agent = tx
      .select({
        sessionId: agentSession.sessionId,
        runTask: { id: issue.id, repo: issue.repo, number: issue.number },
      })
      .from(agentSession)
      .leftJoin(run, eq(run.agentSessionId, agentSession.sessionId))
      .leftJoin(issue, eq(issue.id, run.taskIssueId))
      .where(and(eq(agentSession.terminalSessionId, terminalSessionId), liveAgentSession))
      .get();
    if (agent?.runTask && agent.runTask.id !== found.issue.id) {
      throw new ORPCError("CONFLICT", {
        message: `claude ${agent.sessionId} in this Tab is a Run of ${formatRef(agent.runTask)}, and stays with it until it ends`,
      });
    }
    const agentSessionId = agent?.sessionId ?? null;
    const title = found.issue.title;
    let target = found.bench;
    if (!target) {
      if (!checkout || "missing" in checkout) {
        throw new ORPCError("BAD_REQUEST", { message: checkout?.missing });
      }
      target = insertBench(tx, workbench, found.issue, {
        cwd: checkout.path,
        mode: "in_place",
        setupState: "ready",
      });
    }
    // 同じ Runspace への moveTab は末尾へ並べ替えるので、既に Bench にある Tab には呼ばない。
    if (callerTab.runspaceId === target.runspaceId) {
      return { ref, title, benchCreated: false, runCreated: false, agentSessionId, moved: false };
    }
    workbench.moveTab(tx, callerTab.id, target.runspaceId);
    const orphan = agent && !agent.runTask ? agent : null;
    if (orphan) {
      insertRuns(tx, "attached", [
        { taskIssueId: found.issue.id, agentSessionId: orphan.sessionId },
      ]);
    }
    return {
      ref,
      title,
      benchCreated: !found.bench,
      runCreated: orphan !== null,
      agentSessionId,
      moved: true,
    };
  });
  const { moved, ...output } = attached;
  // current は Tab の居る Bench からも Task を引くので、Run を作らない移動でも知らせる。
  if (moved) deps.publish({ type: "task", ref: output.ref });
  return output;
}

// attach は network を使わないので、checkout が無くても clone しない。
async function checkoutOnDisk(
  { ghq }: BenchDeps,
  forIssue: { repo: string; number: number },
): Promise<Checkout> {
  const ref = formatRef(forIssue);
  try {
    const path = await checkoutOf(ghq, forIssue.repo);
    if (existsSync(path)) return { path };
    return {
      missing: `${ref} has no Bench and its Repo is not cloned at ${path}; attach opens the Bench in place without cloning, so run \`ghq get ${forIssue.repo}\` first`,
    };
  } catch (error) {
    return { missing: `could not find the checkout of ${ref}: ${messageOf(error)}` };
  }
}
