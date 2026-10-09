import { existsSync } from 'node:fs'

import { agentSession } from '@monica/workbench/schema'
import type { Db } from '@monica/workbench/server'
import { and, desc, eq, gte } from 'drizzle-orm'

import type { Bench } from './bench.ts'
import type { PromptKind } from './contract.ts'
import { isIssue, isLinkedIssue, openBlockersOf } from './copy.ts'
import type { GitHubIssue } from './github.ts'
import { type FoundTask, taskIfTracked } from './open-task.ts'
import { formatRef, type IssueRef } from './ref.ts'
import type { Reservations } from './reservation.ts'
import { runAgentSessionsByTask } from './run.ts'
import { issue, run } from './schema.ts'

type Labelled = Pick<GitHubIssue, 'labels' | 'subIssues'>

type Linked = IssueRef & { nodeId: string | null }

export type IssueFacts = IssueRef &
  Labelled &
  Pick<GitHubIssue, 'state'> & {
    blockers: (IssueRef & Pick<GitHubIssue, 'state'>)[]
    parent: (Linked & Labelled) | null
  }

export type Resumable = NonNullable<ReturnType<typeof resumableRunOf>>

export type Launchable =
  | { type: 'new'; kind?: PromptKind }
  | { type: 'resume'; resumable: Resumable }

export type Refusal =
  | { type: 'reopen'; message: string }
  | { type: 'running'; message: string }
  | { type: 'refused'; message: string; blockers: string[] | null; forceHint: string | null }

export type RunPlan = Launchable | Refusal

type Options = { force?: boolean; byLabels?: boolean }

type Launches = Pick<Reservations, 'launchingRun'>

export function planRun(
  db: Db,
  launches: Launches,
  found: FoundTask | undefined,
  facts: IssueFacts,
  options: Options = {},
): RunPlan {
  return planFromLedger(db, launches, found, facts, options) ?? planNewRun(facts, options)
}

export function planFromLedger(
  db: Pick<Db, 'select'>,
  launches: Launches,
  found: FoundTask | undefined,
  facts: IssueFacts,
  { force = false }: Options = {},
): RunPlan | undefined {
  const ref = formatRef(facts)
  if (found?.task.closedAt) {
    return facts.state === 'closed'
      ? closedIssue(ref)
      : { type: 'reopen', message: `${ref} is a closed Task; reopen it to run it` }
  }
  const live = found ? liveRunsOf(db, found.issue.id) : []
  if (live.length > 0) {
    const states = live.map(
      (r) => `${r.sessionId} ${r.state === 'waiting' ? `waiting:${r.waitReason}` : r.state}`,
    )
    return {
      type: 'running',
      message: `${ref} has ${live.length === 1 ? 'a live Run' : 'live Runs'} (${states.join(', ')}); ${ALONGSIDE}`,
    }
  }
  // Run は SessionStart の hook で付くので、Tab を開いてから claude が起動するまでは live な Run に出ない。
  if (found && launches.launchingRun(db, found.issue.id)) {
    return { type: 'running', message: `${ref} has a Run being started; ${ALONGSIDE}` }
  }
  // spec の Run が子を実装している最中なので、子の Run を起こすと resume でも同じ子に 2 つの agent が動く。
  const spec = facts.parent && isSpec(facts.parent) ? facts.parent : null
  if (!force && spec && hasLiveRun(db, spec)) {
    return refused(`${ref} is under ${formatRef(spec)}, a spec with a live Run`, {
      forceHint: 'pass --force to run it anyway',
    })
  }
  const resumable = found?.bench && resumableRunOf(db, found.issue.id, found.bench)
  return resumable ? { type: 'resume', resumable } : undefined
}

export function planNewRun(
  facts: IssueFacts,
  { force = false, byLabels = false }: Options = {},
): RunPlan {
  const ref = formatRef(facts)
  if (!force) {
    if (facts.state === 'closed') return closedIssue(ref)
    const blockers = facts.blockers.filter((b) => b.state === 'open').map(formatRef)
    if (blockers.length > 0) {
      return refused(`${ref} is blocked by ${blockers.join(', ')}`, {
        blockers,
        forceHint: PAST_THE_GATE,
      })
    }
  }
  if (!byLabels) return { type: 'new' }
  const verdict = labelVerdict(facts)
  return 'kind' in verdict ? { type: 'new', kind: verdict.kind } : refused(verdict.message)
}

export function replan(
  tx: Pick<Db, 'select'>,
  launches: Launches,
  found: FoundTask,
  facts: IssueFacts,
  planned: Launchable,
  options: Options = {},
): Refusal | undefined {
  const now = planFromLedger(tx, launches, found, facts, options) ?? { type: 'new' }
  switch (now.type) {
    case 'new':
    case 'resume':
      return sameLaunch(now, planned)
        ? undefined
        : refused(`${formatRef(facts)} changed while its Run was being started; run it again`)
    default:
      return now
  }
}

const sameLaunch = (a: Launchable, b: Launchable) =>
  a.type === 'resume' && b.type === 'resume'
    ? a.resumable.agentSessionId === b.resumable.agentSessionId
    : a.type === b.type

function refused(
  message: string,
  {
    blockers = null,
    forceHint = null,
  }: { blockers?: string[] | null; forceHint?: string | null } = {},
): Refusal {
  return { type: 'refused', message, blockers, forceHint }
}

const ALONGSIDE = 'to add an agent alongside, open a Tab in its Bench and run claude there'

const PAST_THE_GATE = 'pass --force to start a Run anyway'

const closedIssue = (ref: string) =>
  refused(`${ref} is a closed Issue`, { forceHint: PAST_THE_GATE })

const liveRunsOf = (db: Pick<Db, 'select'>, taskIssueId: number) =>
  runAgentSessionsByTask(db, [taskIssueId])(taskIssueId)

function hasLiveRun(db: Pick<Db, 'select'>, linked: Linked): boolean {
  const { nodeId } = linked
  const tracked = taskIfTracked(db, nodeId ? isLinkedIssue({ ...linked, nodeId }) : isIssue(linked))
  return tracked !== undefined && liveRunsOf(db, tracked.issue.id).length > 0
}

// Bench より前の Run は reopen の前の挑戦で、Agent Session Transcript の無い Agent Session（claude は最初の prompt まで書かない）は --resume が会話を見つけられないので、どちらも候補にしない。
function resumableRunOf(
  db: Pick<Db, 'select'>,
  taskIssueId: number,
  since: Pick<Bench, 'createdAt'>,
) {
  return db
    .select({
      agentSessionId: agentSession.sessionId,
      cwd: agentSession.cwd,
      transcriptPath: agentSession.transcriptPath,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(and(eq(run.taskIssueId, taskIssueId), gte(run.startedAt, since.createdAt)))
    .orderBy(desc(agentSession.lastEventAt), desc(run.id))
    .all()
    .find(({ transcriptPath }) => transcriptPath === null || existsSync(transcriptPath))
}

const STATE_LABELS = ['needs-triage', 'ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix']

const isWayfinderLabel = (label: string) => label.startsWith('wayfinder:')

const isStateLabel = (label: string) => STATE_LABELS.includes(label) || isWayfinderLabel(label)

export const isMap = (labelled: Labelled) => labelled.labels.includes('wayfinder:map')

const isSpec = (labelled: Labelled) =>
  labelled.labels.includes('ready-for-agent') && !isMap(labelled) && labelled.subIssues.open > 0

type LabelVerdict = { kind: PromptKind } | { message: string }

const kind = (picked: PromptKind): LabelVerdict => ({ kind: picked })

// 上から順に当て、最初に決まった答えを使う。種類やボタンを出さない条件は、行を足して増やす。
const labelRules: ((facts: IssueFacts) => LabelVerdict | undefined)[] = [
  (facts) => (isMap(facts) ? kind('wayfinder') : undefined),
  (facts) => {
    if (!facts.labels.some(isWayfinderLabel)) return undefined
    if (!facts.parent)
      return { message: `${formatRef(facts)} is a wayfinder Issue with no map above it` }
    return isMap(facts.parent)
      ? kind('wayfinder')
      : {
          message: `${formatRef(facts)} is a wayfinder Issue under ${formatRef(facts.parent)}, which is not a wayfinder:map`,
        }
  },
  (facts) => {
    if (!facts.labels.includes('ready-for-agent')) return undefined
    if (facts.subIssues.total === 0) return kind('tackle')
    return facts.subIssues.open > 0
      ? kind('implement-spec')
      : { message: `${formatRef(facts)} is a spec whose sub-issues are all closed` }
  },
  (facts) =>
    facts.labels.includes('needs-triage') || !facts.labels.some(isStateLabel)
      ? kind('triage')
      : undefined,
]

export function labelVerdict(facts: IssueFacts): LabelVerdict {
  for (const rule of labelRules) {
    const verdict = rule(facts)
    if (verdict) return verdict
  }
  return { message: `${formatRef(facts)} has no label that picks a prompt` }
}

// 写しは Task とその parent と Blocker の Issue しか持たないので、sub-issue は写しにある子だけを数える。spec の子の Task なら、その子自身は数に入る。
export function copyFacts(db: Db, issueId: number): IssueFacts {
  const row = copyOf(db, issueId)
  const parent = row.parentId === null ? undefined : copyOf(db, row.parentId)
  return {
    ...factsOf(db, row),
    blockers: openBlockersOf(db, [issueId]).map(({ repo, number }) => ({
      repo,
      number,
      state: 'open' as const,
    })),
    parent: parent ? { ...factsOf(db, parent), nodeId: parent.nodeId } : null,
  }
}

function copyOf(db: Db, id: number) {
  const row = db.select().from(issue).where(eq(issue.id, id)).get()
  if (!row) throw new Error(`no copy of the Issue ${id}`)
  return row
}

function factsOf(db: Db, row: typeof issue.$inferSelect) {
  const children = db
    .select({ state: issue.state })
    .from(issue)
    .where(eq(issue.parentId, row.id))
    .all()
  return {
    repo: row.repo,
    number: row.number,
    state: row.state,
    labels: row.labels,
    subIssues: {
      open: children.filter((child) => child.state === 'open').length,
      total: children.length,
    },
  }
}
