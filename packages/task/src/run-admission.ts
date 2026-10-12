import { existsSync } from 'node:fs'

import { agentSession } from '@monica/workbench/schema'
import type { Db } from '@monica/workbench/server'
import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'
import { and, desc, eq, gte } from 'drizzle-orm'

import { type Bench, type BenchDeps, refuseInPlace } from './bench.ts'
import { reopenTask } from './close.ts'
import type {
  Pressable,
  PromptKind,
  RunButtonRow,
  RunButtonsOutput,
  RunOutput,
  runErrors,
} from './contract.ts'
import { isIssue, isLinkedIssue, openBlockersOf } from './copy.ts'
import type { GitHubIssue } from './github.ts'
import {
  type FoundTask,
  findOpenTask,
  refuseClosed,
  TaskStateRefusal,
  taskIfTracked,
} from './open-task.ts'
import { key, parsedOrNull, readIssue, readIssues } from './read-issues.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { type Launch, newRun, openRun, refuseUnsendable, resumeOf } from './run-claude.ts'
import { runAgentSessionsByTask } from './run.ts'
import { issue, run } from './schema.ts'
import { type SyncDeps, syncOrUseCopy, trackIssue } from './sync.ts'

type Deps = SyncDeps & BenchDeps

type Via = 'cli' | 'button'

type Rules = { via: Via; force: boolean }

type RunErrors = ORPCErrorConstructorMap<typeof runErrors>

type CliRequest = { via: 'cli'; prompt?: string; force?: boolean; inPlace?: boolean }

type ButtonRequest = { via: 'button'; run: Pressable }

type Labelled = Pick<GitHubIssue, 'labels' | 'subIssues'>

type Linked = IssueRef & { nodeId: string | null }

type IssueFacts = IssueRef &
  Labelled &
  Pick<GitHubIssue, 'state'> & {
    blockers: (IssueRef & Pick<GitHubIssue, 'state'>)[]
    parent: (Linked & Labelled) | null
  }

type Resumable = NonNullable<ReturnType<typeof resumableRunOf>>

type Resuming = { type: 'resume'; resumable: Resumable; kind?: PromptKind }

type Launchable = { type: 'new'; kind?: PromptKind } | Resuming

type Refusal =
  | { type: 'reopen'; message: string }
  | { type: 'running'; message: string; kind?: PromptKind }
  | { type: 'refused'; message: string; blockers: string[] | null }

type Decision = Launchable | Refusal

/** 決める順のどこかで断った印。transaction の中から投げても rollback させる。 */
class Refused extends Error {
  readonly refusal: Refusal

  constructor(refusal: Refusal) {
    super(refusal.message)
    this.refusal = refusal
  }
}

/** CLI の `run` と Run Button の押下が通る 1 つの入口。決める順は `docs/packages/task-ledger.md` の「Run の起動」にある。 */
export function admitRun(
  deps: Deps,
  ref: string,
  request: CliRequest,
  errors: RunErrors,
): Promise<RunOutput>
export function admitRun(deps: Deps, ref: string, request: ButtonRequest): Promise<RunButtonRow>
export function admitRun(
  deps: Deps,
  ref: string,
  request: CliRequest | ButtonRequest,
  errors?: RunErrors,
): Promise<RunOutput | RunButtonRow> {
  return request.via === 'cli'
    ? admitFromCli(deps, ref, request, errors!)
    : press(deps, ref, request.run)
}

async function admitFromCli(
  deps: Deps,
  ref: string,
  { prompt, force = false, inPlace }: CliRequest,
  errors: RunErrors,
): Promise<RunOutput> {
  refuseUnsendable(prompt)
  const rules: Rules = { via: 'cli', force }
  try {
    const { found, tracked } = await findOrTrack(deps, parseRef(ref))
    if (found.bench) refuseInPlace(found.bench, inPlace, formatRef(found.issue))
    const decided = fromLedger(
      deps.db,
      deps.reservations,
      found,
      copyFacts(deps.db, found.issue.id),
      rules,
    )
    if (decided && decided.type !== 'resume') throw new Refused(decided)
    const starting = decided ?? (await syncForNewRun(deps, found))
    return await launch(deps, { found, tracked }, rules, starting, { prompt, inPlace })
  } catch (error) {
    if (error instanceof Refused) throw cliError(error.refusal, errors)
    throw error
  }
}

/** 押下を行っても断っても、押下で最後に判定に使った事実と、押下の後の Task Ledger で決めた次の行を返す。 */
async function press(deps: Deps, ref: string, shown: Pressable): Promise<RunButtonRow> {
  const read = await readIssue(deps, ref)
  if (!read) return { ref, button: null, reason: null }
  const found = taskIfTracked(deps.db, isLinkedIssue(read))
  const decided = decide(deps.db, deps.reservations, found, read, BUTTON)
  const now = rowOf(decided)
  if (now.button?.run !== shown) return { ref, ...now }
  let judged: IssueFacts = read
  try {
    if (decided.type === 'reopen') {
      if (found) await reopenFromButton(deps, found)
    } else if (isLaunchable(decided)) {
      const admitted = await findOrTrack(deps, read, read.nodeId)
      const starting =
        decided.type === 'resume' ? decided : await syncForNewRun(deps, admitted.found, read)
      if ('facts' in starting) judged = starting.facts
      await launch(deps, admitted, BUTTON, starting, {})
    }
  } catch (error) {
    if (!(error instanceof Refused || error instanceof TaskStateRefusal)) throw error
  }
  const after = taskIfTracked(deps.db, isLinkedIssue(read))
  return { ref, ...rowOf(decide(deps.db, deps.reservations, after, judged, BUTTON)) }
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
      const read = parsed && issues.get(key(parsed))
      if (!read) return { ref, button: null, reason: null }
      const found = taskIfTracked(deps.db, isLinkedIssue(read))
      return { ref, ...rowOf(decide(deps.db, deps.reservations, found, read, BUTTON)) }
    }),
  }
}

const BUTTON: Rules = { via: 'button', force: false }

type Admitted = { found: FoundTask; tracked: boolean }

async function launch(
  deps: Deps,
  admitted: Admitted,
  rules: Rules,
  starting: Resuming | Synced,
  { prompt, inPlace }: { prompt?: string; inPlace?: boolean },
): Promise<RunOutput> {
  let launching: Launchable
  let opening: Launch
  let facts: IssueFacts
  let typed = prompt
  if (starting.type === 'resume') {
    launching = starting
    facts = copyFacts(deps.db, admitted.found.issue.id)
    opening = resumeOf(admitted.found, starting.resumable)
  } else {
    facts = starting.facts
    const decided = decideNew(facts, rules)
    if (!isLaunchable(decided)) throw new Refused(decided)
    launching = decided
    typed = rules.via === 'button' ? decided.kind && promptOf(decided.kind, facts) : prompt
    opening = await newRun(deps, starting.found, inPlace, starting.warnings)
  }
  return openRun(deps, opening, { prompt: typed, tracked: admitted.tracked }, (tx, current) => {
    // GitHub と Bench の準備を待つ間に、この Task か spec の Run が起動しうる。
    const changed = recheck(tx, deps.reservations, current, facts, launching, rules)
    if (changed) throw new Refused(changed)
  })
}

function cliError(refusal: Refusal, errors: RunErrors): Error {
  switch (refusal.type) {
    case 'running':
      return new ORPCError('CONFLICT', { message: refusal.message })
    case 'reopen':
      return new ORPCError('PRECONDITION_FAILED', { message: refusal.message })
    case 'refused':
      return refusal.blockers
        ? errors.BLOCKED({ message: refusal.message, data: { blockers: refusal.blockers } })
        : new ORPCError('PRECONDITION_FAILED', { message: refusal.message })
  }
}

// resume と running のボタンはラベルの規則より先に決まるので、ラベルが prompt を選ばない Issue にも出る。
function rowOf(decided: Decision): Pick<RunButtonRow, 'button' | 'reason'> {
  switch (decided.type) {
    case 'reopen':
      return { button: { run: 'reopen' }, reason: null }
    case 'refused':
      return { button: null, reason: decided.message }
    default:
      return {
        button: { ...(decided.kind && { kind: decided.kind }), run: decided.type },
        reason: null,
      }
  }
}

async function reopenFromButton(deps: Deps, tracked: FoundTask) {
  // Task Ledger の写しは次の sync まで repo の改名前の名前を持つので、頼まれた ref でなく node ID で引き当てた Task の ref で reopen する。
  await reopenTask(
    deps,
    { ref: formatRef(tracked.issue) },
    {
      // reopen の sync が判定の後に closed になった Issue を写すので、写しで見直す。
      recheck({ issue: copied }) {
        if (copied.state === 'closed') throw new Refused(closedIssue(formatRef(copied), BUTTON))
      },
    },
  )
}

// track は GitHub の今の名前で Task を書くので、改名前の名前で頼まれても track の返す ref で引き直す。
// 呼び手が GitHub から node ID を引いてあれば、名前と番号が別の issue に移っていても取り違えない。
async function findOrTrack(deps: SyncDeps, asked: IssueRef, nodeId?: string): Promise<Admitted> {
  const found = taskIfTracked(deps.db, isAsked({ ...asked, nodeId }))
  if (found) return { found: refuseClosed(found), tracked: false }
  const { ref, alreadyTracked } = await trackIssue(deps, formatRef(asked))
  return { found: findOpenTask(deps.db, isIssue(parseRef(ref)), ref), tracked: !alreadyTracked }
}

type Synced = { type: 'synced'; found: FoundTask; warnings: string[]; facts: IssueFacts }

async function syncForNewRun(deps: SyncDeps, found: FoundTask, read?: IssueFacts): Promise<Synced> {
  const warnings = await syncOrUseCopy(deps, found.issue)
  // sync は repo の改名を写すので、名前でなく行の id で引き直す。
  const synced = findOpenTask(deps.db, eq(issue.id, found.issue.id), formatRef(found.issue))
  // sync が失敗すると写しは押す前のままなので、押した時に読んだ答えのほうが新しい。
  const facts = read && warnings.length > 0 ? read : copyFacts(deps.db, synced.issue.id)
  return { type: 'synced', found: synced, warnings, facts }
}

const isAsked = ({ nodeId, ...asked }: IssueRef & { nodeId?: string | null }) =>
  nodeId ? isLinkedIssue({ ...asked, nodeId }) : isIssue(asked)

type Launches = Pick<BenchDeps['reservations'], 'launchingRun'>

const isLaunchable = (decided: Decision): decided is Launchable =>
  decided.type === 'new' || decided.type === 'resume'

function decide(
  reader: Pick<Db, 'select'>,
  launches: Launches,
  found: FoundTask | undefined,
  facts: IssueFacts,
  rules: Rules,
): Decision {
  return byLabels(
    fromLedger(reader, launches, found, facts, rules) ?? gate(facts, rules) ?? { type: 'new' },
    facts,
    rules,
  )
}

const decideNew = (facts: IssueFacts, rules: Rules): Decision =>
  byLabels(gate(facts, rules) ?? { type: 'new' }, facts, rules)

function fromLedger(
  reader: Pick<Db, 'select'>,
  launches: Launches,
  found: FoundTask | undefined,
  facts: IssueFacts,
  rules: Rules,
): Refusal | Resuming | undefined {
  const ref = formatRef(facts)
  if (found?.task.closedAt) {
    return facts.state === 'closed'
      ? closedIssue(ref, rules)
      : { type: 'reopen', message: `${ref} is a closed Task; reopen it to run it` }
  }
  const live = found ? liveRunsOf(reader, found.issue.id) : []
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
  if (found && launches.launchingRun(reader, found.issue.id)) {
    return { type: 'running', message: `${ref} has a Run being started; ${ALONGSIDE}` }
  }
  // spec の Run が子を実装している最中なので、子の Run を起こすと resume でも同じ子に 2 つの agent が動く。
  const spec = facts.parent && isSpec(facts.parent) ? facts.parent : null
  if (!rules.force && spec && hasLiveRun(reader, spec)) {
    return refused(`${ref} is under ${formatRef(spec)}, a spec with a live Run`, rules, {
      forceHint: 'pass --force to run it anyway',
    })
  }
  const resumable = found?.bench && resumableRunOf(reader, found.issue.id, found.bench)
  return resumable ? { type: 'resume', resumable } : undefined
}

function gate(facts: IssueFacts, rules: Rules): Refusal | undefined {
  if (rules.force) return undefined
  const ref = formatRef(facts)
  if (facts.state === 'closed') return closedIssue(ref, rules)
  const blockers = facts.blockers.filter((b) => b.state === 'open').map(formatRef)
  if (blockers.length === 0) return undefined
  return refused(`${ref} is blocked by ${blockers.join(', ')}`, rules, {
    blockers,
    forceHint: PAST_THE_GATE,
  })
}

function byLabels(decided: Decision, facts: IssueFacts, rules: Rules): Decision {
  if (rules.via === 'cli' || decided.type === 'reopen' || decided.type === 'refused') return decided
  const verdict = labelVerdict(facts)
  if ('kind' in verdict) return { ...decided, kind: verdict.kind }
  return decided.type === 'new' ? refused(verdict.message, rules) : decided
}

function recheck(
  tx: Pick<Db, 'select'>,
  launches: Launches,
  found: FoundTask,
  facts: IssueFacts,
  planned: Launchable,
  rules: Rules,
): Refusal | undefined {
  const now: Decision = fromLedger(tx, launches, found, facts, rules) ?? { type: 'new' }
  if (!isLaunchable(now)) return now
  return sameLaunch(now, planned)
    ? undefined
    : refused(`${formatRef(facts)} changed while its Run was being started; run it again`, rules)
}

const sameLaunch = (a: Launchable, b: Launchable) =>
  a.type === 'resume' && b.type === 'resume'
    ? a.resumable.agentSessionId === b.resumable.agentSessionId
    : a.type === b.type

// --force の案内は CLI の `run` にだけ出す。Run Button には --force が無い。
function refused(
  message: string,
  { via }: Rules,
  { blockers = null, forceHint }: { blockers?: string[] | null; forceHint?: string } = {},
): Refusal {
  const hinted = via === 'cli' && forceHint ? `${message}; ${forceHint}` : message
  return { type: 'refused', message: hinted, blockers }
}

const ALONGSIDE = 'to add an agent alongside, open a Tab in its Bench and run claude there'

const PAST_THE_GATE = 'pass --force to start a Run anyway'

const closedIssue = (ref: string, rules: Rules) =>
  refused(`${ref} is a closed Issue`, rules, { forceHint: PAST_THE_GATE })

const liveRunsOf = (reader: Pick<Db, 'select'>, taskIssueId: number) =>
  runAgentSessionsByTask(reader, [taskIssueId])(taskIssueId)

function hasLiveRun(reader: Pick<Db, 'select'>, linked: Linked): boolean {
  const tracked = taskIfTracked(reader, isAsked(linked))
  return tracked !== undefined && liveRunsOf(reader, tracked.issue.id).length > 0
}

// Bench より前の Run は reopen の前の挑戦で、Agent Session Transcript の無い Agent Session（claude は最初の prompt まで書かない）は --resume が会話を見つけられないので、どちらも候補にしない。
function resumableRunOf(
  reader: Pick<Db, 'select'>,
  taskIssueId: number,
  since: Pick<Bench, 'createdAt'>,
) {
  return reader
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

const isMap = (labelled: Labelled) => labelled.labels.includes('wayfinder:map')

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

function labelVerdict(facts: IssueFacts): LabelVerdict {
  for (const rule of labelRules) {
    const verdict = rule(facts)
    if (verdict) return verdict
  }
  return { message: `${formatRef(facts)} has no label that picks a prompt` }
}

// tackle は prompt を渡さず、run の既定（新しい Run なら /tackle）に任せる。
function promptOf(picked: PromptKind, facts: IssueFacts): string | undefined {
  switch (picked) {
    case 'tackle':
      return undefined
    case 'implement-spec':
      return `/implement-spec #${facts.number}`
    case 'triage':
      return `/triage #${facts.number}`
    case 'wayfinder':
      return isMap(facts) || !facts.parent
        ? `/wayfinder ${facts.number}`
        : `/wayfinder ${facts.parent.number} ${facts.number}`
  }
}

function copyFacts(db: Db, issueId: number): IssueFacts {
  const row = copyOf(db, issueId)
  const parent = row.parentId === null ? undefined : copyOf(db, row.parentId)
  return {
    ...factsOf(row),
    blockers: openBlockersOf(db, [issueId]).map(({ repo, number }) => ({
      repo,
      number,
      state: 'open' as const,
    })),
    parent: parent ? { ...factsOf(parent), nodeId: parent.nodeId } : null,
  }
}

function copyOf(db: Db, id: number) {
  const row = db.select().from(issue).where(eq(issue.id, id)).get()
  if (!row) throw new Error(`no copy of the Issue ${id}`)
  return row
}

const factsOf = ({ repo, number, state, labels, subIssues }: typeof issue.$inferSelect) => ({
  repo,
  number,
  state,
  labels,
  subIssues,
})
