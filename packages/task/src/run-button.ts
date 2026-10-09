import type { Db } from '@monica/workbench/server'
import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'

import type { BenchDeps } from './bench.ts'
import type { PromptKind, RunButton, RunButtonsOutput, RunOutput, runErrors } from './contract.ts'
import { isLinkedIssue } from './copy.ts'
import { type GitHubIssue, type LinkedIssue, oneLine } from './github.ts'
import { taskIfTracked } from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { resumableRunOf, runTask } from './run-claude.ts'
import { runAgentSessionsByTask } from './run.ts'
import { queryByRepo, type SyncDeps } from './sync.ts'

const READ_TIMEOUT_MS = 10_000

/** ボタンを決める材料。Issue は GitHub の今の答えで、Task は track 済みのときだけある。 */
type Seen = {
  issue: GitHubIssue
  task: { closed: boolean; run: RunState } | null
  /** 親が spec で live な Run を持つとき、その親。 */
  runningSpec: IssueRef | null
}

type RunState = Exclude<RunButton['run'], 'reopen'>

type Verdict =
  | { type: 'button'; kind: PromptKind }
  | { type: 'reopen'; message: string }
  | { type: 'blocked'; message: string; blockers: string[] }
  | { type: 'none'; message: string }

const button = (kind: PromptKind): Verdict => ({ type: 'button', kind })

const noButton = (message: string): Verdict => ({ type: 'none', message })

const STATE_LABELS = ['needs-triage', 'ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix']

const isWayfinderLabel = (label: string) => label.startsWith('wayfinder:')

const isStateLabel = (label: string) => STATE_LABELS.includes(label) || isWayfinderLabel(label)

type Labelled = Pick<GitHubIssue, 'labels' | 'subIssues'>

const isMap = (issue: Labelled) => issue.labels.includes('wayfinder:map')

const isSpec = (issue: Labelled) =>
  issue.labels.includes('ready-for-agent') && !isMap(issue) && issue.subIssues.open > 0

const underRunningSpec = (issue: IssueRef, spec: IssueRef) =>
  `${formatRef(issue)} is under ${formatRef(spec)}, a spec with a live Run`

// 上から順に当て、最初に決まった答えを使う。種類やボタンを出さない条件は、行を足して増やす。
const rules: ((seen: Seen) => Verdict | undefined)[] = [
  ({ issue }) =>
    issue.state === 'closed' ? noButton(`${formatRef(issue)} is a closed Issue`) : undefined,
  ({ issue, task }) =>
    task?.closed
      ? { type: 'reopen', message: `${formatRef(issue)} is a closed Task; reopen it to run it` }
      : undefined,
  ({ issue }) => {
    const blockers = issue.blockers.filter((b) => b.state === 'open').map(formatRef)
    if (blockers.length === 0) return undefined
    return {
      type: 'blocked',
      message: `${formatRef(issue)} is blocked by ${blockers.join(', ')}`,
      blockers,
    }
  },
  // spec の Run が子を実装している最中なので、子を別に run すると同じ子に 2 つの Run が走る。
  ({ issue, runningSpec }) =>
    runningSpec ? noButton(underRunningSpec(issue, runningSpec)) : undefined,
  ({ issue }) => (isMap(issue) ? button('wayfinder') : undefined),
  ({ issue }) => {
    if (!issue.labels.some(isWayfinderLabel)) return undefined
    if (!issue.parent)
      return noButton(`${formatRef(issue)} is a wayfinder Issue with no map above it`)
    return isMap(issue.parent)
      ? button('wayfinder')
      : noButton(
          `${formatRef(issue)} is a wayfinder Issue under ${formatRef(issue.parent)}, which is not a wayfinder:map`,
        )
  },
  ({ issue }) => {
    if (!issue.labels.includes('ready-for-agent')) return undefined
    if (issue.subIssues.total === 0) return button('tackle')
    return issue.subIssues.open > 0
      ? button('implement-spec')
      : noButton(`${formatRef(issue)} is a spec whose sub-issues are all closed`)
  },
  ({ issue }) =>
    issue.labels.includes('needs-triage') || !issue.labels.some(isStateLabel)
      ? button('triage')
      : undefined,
]

function verdictOf(seen: Seen): Verdict {
  for (const rule of rules) {
    const verdict = rule(seen)
    if (verdict) return verdict
  }
  return noButton(`${formatRef(seen.issue)} has no label that picks a prompt`)
}

// tackle は prompt を渡さず、run の既定（新しい Run なら /tackle、resume なら何も送らない）に任せる。
function promptOf(kind: PromptKind, issue: GitHubIssue): string | undefined {
  switch (kind) {
    case 'tackle':
      return undefined
    case 'implement-spec':
      return `/implement-spec #${issue.number}`
    case 'triage':
      return `/triage #${issue.number}`
    case 'wayfinder':
      return isMap(issue) || !issue.parent
        ? `/wayfinder ${issue.number}`
        : `/wayfinder ${issue.parent.number} ${issue.number}`
  }
}

export async function runButtons(deps: SyncDeps, refs: string[]): Promise<RunButtonsOutput> {
  const asked = refs.map((ref) => ({ ref, parsed: parsedOrNull(ref) }))
  const { issues } = await readIssues(
    deps,
    asked.flatMap(({ parsed }) => (parsed ? [parsed] : [])),
  )
  return {
    buttons: asked.map(({ ref, parsed }) => {
      const issue = parsed && issues.get(key(parsed))
      if (!issue) return { ref, button: null, reason: null }
      const seen = seenOf(deps.db, issue)
      const verdict = verdictOf(seen)
      switch (verdict.type) {
        case 'button':
          return { ref, button: { kind: verdict.kind, run: seen.task?.run ?? 'new' }, reason: null }
        case 'reopen':
          return { ref, button: { run: 'reopen' as const }, reason: null }
        default:
          return { ref, button: null, reason: verdict.message }
      }
    }),
  }
}

export async function runFromButton(
  deps: SyncDeps & BenchDeps,
  ref: string,
  errors: ORPCErrorConstructorMap<typeof runErrors>,
): Promise<RunOutput> {
  const parsed = parseRef(ref)
  const { issues, failures } = await readIssues(deps, [parsed])
  const issue = issues.get(key(parsed))
  if (!issue) {
    if (failures.length > 0) {
      throw new ORPCError('BAD_GATEWAY', {
        message: `could not read ${formatRef(parsed)} from GitHub: ${failures.join('; ')}`,
      })
    }
    throw new ORPCError('NOT_FOUND', { message: `GitHub did not return ${formatRef(parsed)}` })
  }
  const seen = seenOf(deps.db, issue)
  const verdict = verdictOf(seen)
  switch (verdict.type) {
    case 'blocked':
      throw errors.BLOCKED({ message: verdict.message, data: { blockers: verdict.blockers } })
    case 'reopen':
    case 'none':
      throw refused(verdict.message)
  }
  // resume する claude は前の会話の途中か後なので、どの種類の prompt も送り直さない（ADR-0024）。
  const prompt = seen.task?.run === 'resume' ? undefined : promptOf(verdict.kind, issue)
  const spec = issue.parent && isSpec(issue.parent) ? issue.parent : null
  return runTask(deps, { ref, prompt }, errors, {
    nodeId: issue.nodeId,
    // GitHub と Bench の準備を待つ間に spec の Run が起動しうるので、Tab を開く transaction の中で見直す。
    recheck(tx) {
      if (spec && hasLiveRun(tx, spec)) throw refused(underRunningSpec(issue, spec))
    },
  })
}

const refused = (message: string) => new ORPCError('PRECONDITION_FAILED', { message })

function seenOf(db: Db, issue: GitHubIssue): Seen {
  const tracked = taskIfTracked(db, isLinkedIssue(issue))
  const { parent } = issue
  return {
    issue,
    task: tracked ? { closed: tracked.task.closedAt !== null, run: runOf(db, tracked) } : null,
    runningSpec: parent && isSpec(parent) && hasLiveRun(db, parent) ? parent : null,
  }
}

function hasLiveRun(db: Pick<Db, 'select'>, linked: LinkedIssue): boolean {
  const tracked = taskIfTracked(db, isLinkedIssue(linked))
  return tracked !== undefined && liveRunCount(db, tracked.issue.id) > 0
}

const liveRunCount = (db: Pick<Db, 'select'>, taskIssueId: number) =>
  runAgentSessionsByTask(db, [taskIssueId])(taskIssueId).length

// run と同じ規則で決める。live な Run は CONFLICT で断られ、resume の候補は今の Bench の後に始まった Run だけ。
function runOf(
  db: Db,
  { issue: { id }, bench }: NonNullable<ReturnType<typeof taskIfTracked>>,
): RunState {
  if (!bench) return 'new'
  if (liveRunCount(db, id) > 0) return 'running'
  return resumableRunOf(db, id, bench) ? 'resume' : 'new'
}

function parsedOrNull(ref: string): IssueRef | null {
  try {
    return parseRef(ref)
  } catch {
    return null
  }
}

// GitHub は改名前の名前で頼んでも今の名前で返すので、頼んだ名前と番号で引き当てる。
const key = ({ repo, number }: IssueRef) => `${repo.toLowerCase()}#${number}`

const reason = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error))

/** Track せず、写しにも書かない。失敗した repo の Issue は答えに入らず、理由が `failures` に残る。 */
async function readIssues(
  deps: SyncDeps,
  refs: IssueRef[],
): Promise<{ issues: Map<string, GitHubIssue>; failures: string[] }> {
  const issues = new Map<string, GitHubIssue>()
  const failures: string[] = []
  if (refs.length === 0) return { issues, failures }
  const signal = deps.signal(READ_TIMEOUT_MS)
  let token: string
  try {
    token = await deps.github.token(signal)
  } catch (error) {
    return { issues, failures: [reason(error)] }
  }
  await queryByRepo({ url: deps.github.url, token }, refs, signal, {
    answered(repo, answer) {
      for (const found of answer.issues) issues.set(key({ repo, number: found.number }), found)
    },
    failed(repo, _, error) {
      failures.push(`${repo}: ${reason(error)}`)
    },
  })
  return { issues, failures }
}
