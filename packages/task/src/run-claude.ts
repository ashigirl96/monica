import { existsSync } from 'node:fs'

import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'
import { eq } from 'drizzle-orm'

import { type Bench, type BenchDeps, prepareBench, refuseInPlace } from './bench.ts'
import type { RunOutput, runErrors } from './contract.ts'
import { isIssue, isLinkedIssue } from './copy.ts'
import { type FoundTask, findOpenTask, refuseClosed, taskIfTracked } from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import {
  copyFacts,
  type IssueFacts,
  type Launchable,
  planFromLedger,
  planNewRun,
  replan,
  type Refusal,
  type Resumable,
  type RunPlan,
} from './run-plan.ts'
import { issue } from './schema.ts'
import { type SyncDeps, syncOrUseCopy, trackIssue } from './sync.ts'

type Launch = {
  ref: string
  title: string
  bench: Bench
  benchCreated: boolean
  warnings: string[]
  tabCwd: string
  resumed: string | null
}

export type RunErrors = ORPCErrorConstructorMap<typeof runErrors>

type Request = { prompt?: string; inPlace?: boolean; force?: boolean }

type Planned = {
  found: FoundTask
  tracked: boolean
  facts: IssueFacts
  plan: RunPlan
  warnings: string[]
}

export async function runTask(
  deps: SyncDeps & BenchDeps,
  input: Request & { ref: string },
  errors: RunErrors,
): Promise<RunOutput> {
  refuseUnsendable(input.prompt)
  const { found, tracked } = await findOrTrack(deps, parseRef(input.ref))
  if (found.bench) refuseInPlace(found.bench, input.inPlace, formatRef(found.issue))
  const facts = copyFacts(deps.db, found.issue.id)
  const fromLedger = planFromLedger(deps.db, found, facts, input)
  const refuse = (refusal: Refusal) => refusalOf(refusal, errors, { hintForce: true })
  if (fromLedger)
    return start(deps, { found, tracked, facts, plan: fromLedger, warnings: [] }, input, refuse)
  const synced = await syncForNewRun(deps, found)
  const syncedFacts = copyFacts(deps.db, synced.found.issue.id)
  const plan = planNewRun(syncedFacts, input)
  return start(deps, { ...synced, tracked, facts: syncedFacts, plan }, input, refuse)
}

export async function runPlanned(
  deps: SyncDeps & BenchDeps,
  {
    facts,
    nodeId,
    plan,
    prompt,
  }: { facts: IssueFacts; nodeId: string; plan: Launchable; prompt?: string },
  errors: RunErrors,
): Promise<RunOutput> {
  const { found, tracked } = await findOrTrack(deps, facts, nodeId)
  const refuse = (refusal: Refusal) => refusalOf(refusal, errors)
  const launching =
    plan.type === 'resume'
      ? { found, tracked, facts, plan, warnings: [] }
      : { ...(await syncForNewRun(deps, found)), tracked, facts, plan }
  return start(deps, launching, { prompt }, refuse)
}

async function start(
  deps: SyncDeps & BenchDeps,
  { found, tracked, facts, plan, warnings }: Planned,
  request: Request,
  refuse: (refusal: Refusal) => Error,
): Promise<RunOutput> {
  if (plan.type !== 'new' && plan.type !== 'resume') throw refuse(plan)
  const launch =
    plan.type === 'resume'
      ? resumeOf(found, plan.resumable)
      : await newRun(deps, found, request.inPlace, warnings)
  const opened = deps.reservations.writeOpenTask(
    launch.bench.taskIssueId,
    launch.ref,
    (tx, current) => {
      // GitHub と Bench の準備を待つ間に、この Task か spec の Run が起動しうる。
      const changed = replan(tx, current, facts, plan, request)
      if (changed) throw refuse(changed)
      return deps.workbenchLedger.openTab(tx, {
        runspaceId: launch.bench.runspaceId,
        cwd: launch.tabCwd,
        input: `${claudeCommand(launch, request.prompt)}\r`,
      })
    },
  )
  return {
    ref: launch.ref,
    title: launch.title,
    tracked,
    cwd: launch.bench.cwd,
    mode: launch.bench.mode,
    benchCreated: launch.benchCreated,
    warnings: launch.warnings,
    ...opened,
    resumed: launch.resumed,
  }
}

export function refusalOf(
  refusal: Refusal,
  errors: RunErrors,
  { hintForce = false }: { hintForce?: boolean } = {},
): Error {
  switch (refusal.type) {
    case 'running':
      return new ORPCError('CONFLICT', { message: refusal.message })
    case 'reopen':
      return new ORPCError('PRECONDITION_FAILED', { message: refusal.message })
    case 'refused': {
      const message =
        hintForce && refusal.forceHint
          ? `${refusal.message}; ${refusal.forceHint}`
          : refusal.message
      return refusal.blockers
        ? errors.BLOCKED({ message, data: { blockers: refusal.blockers } })
        : new ORPCError('PRECONDITION_FAILED', { message })
    }
  }
}

// track は GitHub の今の名前で Task を書くので、改名前の名前で頼まれても track の返す ref で引き直す。
// 呼び手が GitHub から node ID を引いてあれば、名前と番号が別の issue に移っていても取り違えない。
async function findOrTrack(deps: SyncDeps, asked: IssueRef, nodeId?: string) {
  const found = taskIfTracked(
    deps.db,
    nodeId ? isLinkedIssue({ ...asked, nodeId }) : isIssue(asked),
  )
  if (found) return { found: refuseClosed(found), tracked: false }
  const { ref, alreadyTracked } = await trackIssue(deps, formatRef(asked))
  return { found: findOpenTask(deps.db, isIssue(parseRef(ref)), ref), tracked: !alreadyTracked }
}

function resumeOf({ issue: forIssue, bench: row }: FoundTask, last: Resumable): Launch {
  if (!row) throw new Error(`${formatRef(forIssue)} has a Run to resume but no Bench`)
  return {
    ref: formatRef(forIssue),
    title: forIssue.title,
    bench: row,
    benchCreated: false,
    warnings: [],
    tabCwd: existsSync(last.cwd) ? last.cwd : row.cwd,
    resumed: last.agentSessionId,
  }
}

async function syncForNewRun(deps: SyncDeps, found: FoundTask) {
  const warnings = await syncOrUseCopy(deps, found.issue)
  // sync は repo の改名を写すので、名前でなく行の id で引き直す。
  const synced = findOpenTask(deps.db, eq(issue.id, found.issue.id), formatRef(found.issue))
  return { found: synced, warnings }
}

async function newRun(
  deps: SyncDeps & BenchDeps,
  synced: FoundTask,
  inPlace: boolean | undefined,
  warnings: string[],
): Promise<Launch> {
  const prepared = await prepareBench(deps, synced, inPlace)
  return {
    ref: formatRef(synced.issue),
    title: synced.issue.title,
    bench: prepared.bench,
    benchCreated: prepared.created,
    warnings: [...warnings, ...prepared.warnings],
    tabCwd: prepared.bench.cwd,
    resumed: null,
  }
}

const DEFAULT_PROMPT = '/tackle'

// 空の prompt は素の claude を起こす抜け道になり、shell に打鍵した制御文字は Enter や Ctrl-C として働く。
function refuseUnsendable(prompt: string | undefined) {
  if (prompt === undefined) return
  if (prompt.trim() === '') throw unsendable(`is empty; leave it out to send ${DEFAULT_PROMPT}`)
  if (/\p{Cc}/u.test(prompt)) {
    throw unsendable(
      'has a control character such as a newline, which the shell would take as a key',
    )
  }
  if (prompt.startsWith('-'))
    throw unsendable('starts with -, which claude would read as an option')
}

function unsendable(reason: string) {
  return new ORPCError('BAD_REQUEST', { message: `the prompt ${reason}` })
}

// resume する claude は tackle の途中か後なので、既定の prompt を送ると branch を切るところからやり直す。
function claudeCommand({ resumed }: Launch, prompt: string | undefined): string {
  const words =
    resumed === null
      ? [quote(prompt ?? DEFAULT_PROMPT)]
      : ['--resume', quote(resumed), ...(prompt === undefined ? [] : [quote(prompt)])]
  return ['claude', ...words].join(' ')
}

// single quote の中では ' を escape できないので、一度閉じて \' を挟み、開き直す。
function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}
