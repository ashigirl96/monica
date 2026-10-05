import { existsSync } from 'node:fs'

import { ORPCError } from '@orpc/server'
import { agentSession, tab } from '@tania/workbench/schema'
import { and, eq } from 'drizzle-orm'

import { type BenchDeps, insertBench, refuseClosing } from './bench.ts'
import type { AttachOutput } from './contract.ts'
import { isIssue } from './copy.ts'
import { callerTerminalSession } from './current.ts'
import { findOpenTask } from './open-task.ts'
import { checkoutUnder, type Ghq, messageOf } from './prepare.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { insertRuns, liveAgentSession } from './run.ts'
import { issue, run } from './schema.ts'

type GhqRoot = { path: string } | { error: string }

export async function attachTab(
  deps: BenchDeps,
  input: { ref: string; terminalSessionId?: string },
): Promise<AttachOutput> {
  const { db, workbenchLedger } = deps
  const terminalSessionId = callerTerminalSession(input.terminalSessionId)
  const asked = parseRef(input.ref)
  const requested = findOpenTask(db, isIssue(asked), formatRef(asked))
  // ghq root は async なので transaction の前に引く。待つ間に run が Bench を作ることも、sync が repo の改名を写すこともある。
  const ghqRoot = requested.bench ? null : await lookUpGhqRoot(deps.ghq)
  const attached = db.transaction((tx): AttachOutput & { moved: boolean } => {
    const callerTab = tx
      .select({ id: tab.id, runspaceId: tab.runspaceId })
      .from(tab)
      .where(eq(tab.terminalSessionId, terminalSessionId))
      .get()
    if (!callerTab) {
      throw new ORPCError('BAD_REQUEST', {
        message: `Terminal Session ${terminalSessionId} is in no Tab; reattach it to a Tab first`,
      })
    }
    const found = findOpenTask(tx, eq(issue.id, requested.issue.id), formatRef(requested.issue))
    const ref = formatRef(found.issue)
    refuseClosing(deps, found.issue.id, ref)
    const agent = tx
      .select({
        sessionId: agentSession.sessionId,
        runTask: { id: issue.id, repo: issue.repo, number: issue.number },
      })
      .from(agentSession)
      .leftJoin(run, eq(run.agentSessionId, agentSession.sessionId))
      .leftJoin(issue, eq(issue.id, run.taskIssueId))
      .where(and(eq(agentSession.terminalSessionId, terminalSessionId), liveAgentSession))
      .get()
    if (agent?.runTask && agent.runTask.id !== found.issue.id) {
      throw new ORPCError('CONFLICT', {
        message: `claude ${agent.sessionId} in this Tab is a Run of ${formatRef(agent.runTask)}, and stays with it until it ends`,
      })
    }
    const agentSessionId = agent?.sessionId ?? null
    const title = found.issue.title
    let target = found.bench
    if (!target) {
      target = insertBench(tx, workbenchLedger, found.issue, {
        cwd: checkoutOnDisk(ghqRoot, found.issue),
        mode: 'in_place',
        setupState: 'ready',
      })
    }
    // 同じ Runspace への moveTab は末尾へ並べ替えるので、既に Bench にある Tab には呼ばない。
    if (callerTab.runspaceId === target.runspaceId) {
      return { ref, title, benchCreated: false, runCreated: false, agentSessionId, moved: false }
    }
    workbenchLedger.moveTab(tx, callerTab.id, target.runspaceId)
    const orphan = agent && !agent.runTask ? agent : null
    if (orphan) {
      insertRuns(tx, 'attached', [
        { taskIssueId: found.issue.id, agentSessionId: orphan.sessionId },
      ])
    }
    return {
      ref,
      title,
      benchCreated: !found.bench,
      runCreated: orphan !== null,
      agentSessionId,
      moved: true,
    }
  })
  const { moved, ...output } = attached
  // current は Tab の居る Bench からも Task を引くので、Run を作らない移動でも知らせる。
  if (moved) deps.publish({ type: 'task', ref: output.ref })
  return output
}

function lookUpGhqRoot(ghq: Ghq): Promise<GhqRoot> {
  return ghq.root().then(
    (path) => ({ path }),
    (error: unknown) => ({ error: messageOf(error) }),
  )
}

// attach は network を使わないので、checkout が無くても clone しない。
function checkoutOnDisk(ghqRoot: GhqRoot | null, forIssue: IssueRef): string {
  const ref = formatRef(forIssue)
  if (!ghqRoot || 'error' in ghqRoot) {
    throw new ORPCError('BAD_REQUEST', {
      message: `could not find the checkout of ${ref}: ${ghqRoot?.error ?? 'ghq root was not looked up'}`,
    })
  }
  const path = checkoutUnder(ghqRoot.path, forIssue.repo)
  if (!existsSync(path)) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${ref} has no Bench and its Repo is not cloned at ${path}; attach opens the Bench in place without cloning, so run \`ghq get ${forIssue.repo}\` first`,
    })
  }
  return path
}
