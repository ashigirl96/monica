import type { Db } from '@monica/workbench/server'
import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'

import type { BenchDeps } from './bench.ts'
import type {
  PromptKind,
  RunButton,
  RunButtonsOutput,
  RunOutput,
  runFromButtonErrors,
} from './contract.ts'
import { isIssue } from './copy.ts'
import { BATCH, type GitHubIssue, oneLine, queryIssues } from './github.ts'
import { taskIfTracked } from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { resumableRunOf, runTask } from './run-claude.ts'
import { runAgentSessionsByTask } from './run.ts'
import { byRepo, type SyncDeps } from './sync.ts'

const READ_TIMEOUT_MS = 10_000

/** ボタンを決める材料。Issue は GitHub の今の答えで、Task は track 済みのときだけある。 */
type Seen = {
  issue: GitHubIssue
  task: { closed: boolean; run: RunButton['run'] } | null
  parentRunning: boolean
}

type Refusal =
  | { code: 'BLOCKED'; message: string; blockers: string[] }
  | { code: 'NO_RUN_BUTTON'; message: string }

type Verdict = { kind: PromptKind } | { refusal: Refusal }

const noButton = (message: string): Verdict => ({ refusal: { code: 'NO_RUN_BUTTON', message } })

const STATE_LABELS = ['needs-triage', 'ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix']

const isWayfinderLabel = (label: string) => label.startsWith('wayfinder:')

const isStateLabel = (label: string) => STATE_LABELS.includes(label) || isWayfinderLabel(label)

const isMap = (issue: GitHubIssue) => issue.labels.includes('wayfinder:map')

// 上から順に当て、最初に決まった答えを使う。種類やボタンを出さない条件は、行を足して増やす。
const rules: ((seen: Seen) => Verdict | undefined)[] = [
  ({ issue }) =>
    issue.state === 'closed' ? noButton(`${formatRef(issue)} is a closed Issue`) : undefined,
  ({ issue, task }) =>
    task?.closed
      ? noButton(`${formatRef(issue)} is a closed Task; reopen it to run it`)
      : undefined,
  ({ issue }) => {
    const blockers = issue.blockers.filter((b) => b.state === 'open').map(formatRef)
    if (blockers.length === 0) return undefined
    return {
      refusal: {
        code: 'BLOCKED',
        message: `${formatRef(issue)} is blocked by ${blockers.join(', ')}`,
        blockers,
      },
    }
  },
  ({ issue }) => (isMap(issue) ? { kind: 'wayfinder' } : undefined),
  ({ issue }) => {
    if (!issue.labels.some(isWayfinderLabel)) return undefined
    return issue.parent
      ? { kind: 'wayfinder' }
      : noButton(`${formatRef(issue)} is a wayfinder Issue with no map above it`)
  },
  ({ issue, parentRunning }) => {
    if (!issue.labels.includes('ready-for-agent')) return undefined
    // spec の Run が子を実装している最中なので、子を別に run すると同じ実装が 2 つ走る。
    if (parentRunning && issue.parent) {
      return noButton(
        `${formatRef(issue)} is under ${formatRef(issue.parent)}, which has a live Run`,
      )
    }
    if (issue.subIssues.total === 0) return { kind: 'tackle' }
    return issue.subIssues.open > 0
      ? { kind: 'implement-spec' }
      : noButton(`${formatRef(issue)} is a spec whose sub-issues are all closed`)
  },
  ({ issue }) =>
    issue.labels.includes('needs-triage') || !issue.labels.some(isStateLabel)
      ? { kind: 'triage' }
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
      if (!issue) return { ref, button: null }
      const seen = seenOf(deps.db, parsed, issue)
      const verdict = verdictOf(seen)
      return {
        ref,
        button: 'kind' in verdict ? { kind: verdict.kind, run: seen.task?.run ?? 'new' } : null,
      }
    }),
  }
}

export async function runFromButton(
  deps: SyncDeps & BenchDeps,
  ref: string,
  errors: ORPCErrorConstructorMap<typeof runFromButtonErrors>,
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
  const seen = seenOf(deps.db, parsed, issue)
  const verdict = verdictOf(seen)
  if ('refusal' in verdict) {
    const { refusal } = verdict
    if (refusal.code === 'BLOCKED') {
      throw errors.BLOCKED({ message: refusal.message, data: { blockers: refusal.blockers } })
    }
    throw errors.NO_RUN_BUTTON({ message: refusal.message })
  }
  // resume する claude は前の会話の途中か後なので、どの種類の prompt も送り直さない（ADR-0024）。
  const prompt = seen.task?.run === 'resume' ? undefined : promptOf(verdict.kind, issue)
  return runTask(deps, { ref, prompt }, errors)
}

const reason = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error))

function seenOf(db: Db, ref: IssueRef, issue: GitHubIssue): Seen {
  const tracked = taskIfTracked(db, isIssue(ref))
  return {
    issue,
    task: tracked ? { closed: tracked.task.closedAt !== null, run: runOf(db, tracked) } : null,
    parentRunning: issue.parent !== null && parentHasLiveRun(db, issue.parent),
  }
}

function parentHasLiveRun(db: Db, parent: IssueRef): boolean {
  const tracked = taskIfTracked(db, isIssue(parent))
  return tracked ? hasLiveRun(db, tracked.issue.id) : false
}

const hasLiveRun = (db: Db, taskIssueId: number) =>
  runAgentSessionsByTask(db, [taskIssueId])(taskIssueId).length > 0

// run と同じ規則で決める。live な Run は CONFLICT で断られ、resume の候補は今の Bench の後に始まった Run だけ。
function runOf(
  db: Db,
  { issue: { id }, bench }: NonNullable<ReturnType<typeof taskIfTracked>>,
): RunButton['run'] {
  if (!bench) return 'new'
  if (hasLiveRun(db, id)) return 'running'
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
  await Promise.all(
    byRepo(refs).map(async ([repo, numbers]) => {
      try {
        for (let i = 0; i < numbers.length; i += BATCH) {
          const answer = await queryIssues(
            { url: deps.github.url, token },
            repo,
            numbers.slice(i, i + BATCH).map((number) => ({ number, benchBranch: null })),
            signal,
          )
          for (const found of answer.issues) issues.set(key({ repo, number: found.number }), found)
        }
      } catch (error) {
        failures.push(`${repo}: ${reason(error)}`)
      }
    }),
  )
  return { issues, failures }
}
