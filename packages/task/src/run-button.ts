import { ORPCError } from '@orpc/server'

import type { BenchDeps } from './bench.ts'
import { reopenTask } from './close.ts'
import type { Pressable, PromptKind, RunButtonRow, RunButtonsOutput } from './contract.ts'
import { isLinkedIssue } from './copy.ts'
import { type GitHubIssue, oneLine } from './github.ts'
import { TaskStateRefusal, taskIfTracked } from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { runPlanned } from './run-claude.ts'
import { isMap, labelVerdict, planRun, type RunPlan } from './run-plan.ts'
import { queryByRepo, type SyncDeps } from './sync.ts'

const READ_TIMEOUT_MS = 10_000

// tackle は prompt を渡さず、run の既定（新しい Run なら /tackle）に任せる。
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

function planOf({ db, reservations }: Pick<BenchDeps, 'db' | 'reservations'>, issue: GitHubIssue) {
  const tracked = taskIfTracked(db, isLinkedIssue(issue))
  return { tracked, plan: planRun(db, reservations, tracked, issue, { byLabels: true }) }
}

// resume と running のボタンはラベルの規則より先に決まるので、ラベルが prompt を選ばない Issue にも出る。
function buttonOf(plan: RunPlan, issue: GitHubIssue): Pick<RunButtonRow, 'button' | 'reason'> {
  switch (plan.type) {
    case 'reopen':
      return { button: { run: 'reopen' }, reason: null }
    case 'refused':
      return { button: null, reason: plan.message }
    case 'new':
      return { button: { ...(plan.kind && { kind: plan.kind }), run: 'new' }, reason: null }
    default: {
      const verdict = labelVerdict(issue)
      return {
        button: { ...('kind' in verdict && { kind: verdict.kind }), run: plan.type },
        reason: null,
      }
    }
  }
}

export async function runButtons(
  deps: SyncDeps & Pick<BenchDeps, 'reservations'>,
  refs: string[],
): Promise<RunButtonsOutput> {
  const asked = refs.map((ref) => ({ ref, parsed: parsedOrNull(ref) }))
  const { issues } = await readIssues(
    deps,
    asked.flatMap(({ parsed }) => (parsed ? [parsed] : [])),
  )
  return {
    buttons: asked.map(({ ref, parsed }) => {
      const issue = parsed && issues.get(key(parsed))
      if (!issue) return { ref, button: null, reason: null }
      return { ref, ...buttonOf(planOf(deps, issue).plan, issue) }
    }),
  }
}

/** 押下を行っても断っても、押す前に読んだ Issue と押下の後の Task Ledger で決めた次の行を返す。 */
export async function press(
  deps: SyncDeps & BenchDeps,
  ref: string,
  shown: Pressable,
): Promise<RunButtonRow> {
  const issue = await readIssue(deps, ref)
  if (!issue) return { ref, button: null, reason: null }
  const planned = planOf(deps, issue)
  const now = buttonOf(planned.plan, issue)
  if (now.button?.run !== shown) return { ref, ...now }
  try {
    await carryOut(deps, issue, planned)
  } catch (error) {
    if (!isRefusal(error)) throw error
  }
  return { ref, ...buttonOf(planOf(deps, issue).plan, issue) }
}

async function carryOut(
  deps: SyncDeps & BenchDeps,
  issue: GitHubIssue,
  { tracked, plan }: ReturnType<typeof planOf>,
): Promise<void> {
  switch (plan.type) {
    // resume する claude は前の会話の途中か後なので、どの種類の prompt も送り直さない（ADR-0024）。
    case 'resume':
      await runPlanned(deps, { facts: issue, nodeId: issue.nodeId, plan }, refuse)
      return
    case 'new': {
      const prompt = plan.kind && promptOf(plan.kind, issue)
      await runPlanned(deps, { facts: issue, nodeId: issue.nodeId, plan, prompt }, refuse)
      return
    }
    case 'reopen':
      if (!tracked) return
      // Task Ledger の写しは次の sync まで repo の改名前の名前を持つので、頼まれた ref でなく node ID で引き当てた Task の ref で reopen する。
      await reopenTask(
        deps,
        { ref: formatRef(tracked.issue) },
        {
          // reopen の sync が判定の後に closed になった Issue を写すので、写しで見直す。
          recheck({ issue: copied }) {
            if (copied.state === 'closed') throw refuse()
          },
        },
      )
  }
}

/** 押下を規則か live な Run が断った印。 */
class Refused extends Error {}

const refuse = () => new Refused()

const isRefusal = (error: unknown) => error instanceof Refused || error instanceof TaskStateRefusal

async function readIssue(deps: SyncDeps, ref: string): Promise<GitHubIssue | undefined> {
  const parsed = parseRef(ref)
  const { issues, failures } = await readIssues(deps, [parsed])
  const issue = issues.get(key(parsed))
  if (issue || failures.length === 0) return issue
  throw new ORPCError('BAD_GATEWAY', {
    message: `could not read ${formatRef(parsed)} from GitHub: ${failures.join('; ')}`,
  })
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
