import { existsSync } from 'node:fs'

import type { Tx } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'

import { type Bench, type BenchDeps, prepareBench } from './bench.ts'
import type { RunOutput } from './contract.ts'
import type { FoundTask } from './open-task.ts'
import { formatRef } from './ref.ts'

export type Launch = {
  ref: string
  title: string
  bench: Bench
  benchCreated: boolean
  warnings: string[]
  tabCwd: string
  resumed: string | null
}

/** Bench の新しい Tab で claude を打つ。`recheck` は Tab を開く transaction の中で呼び、throw すれば Tab を開かない。 */
export function openRun(
  deps: BenchDeps,
  launch: Launch,
  { prompt, tracked }: { prompt: string | undefined; tracked: boolean },
  recheck: (tx: Tx, current: FoundTask) => void,
): RunOutput {
  const opened = deps.reservations.openRunTab(
    launch.bench.taskIssueId,
    launch.ref,
    (tx, current) => {
      recheck(tx, current)
      return deps.workbenchLedger.openTab(tx, {
        runspaceId: launch.bench.runspaceId,
        cwd: launch.tabCwd,
        input: `${claudeCommand(launch, prompt)}\r`,
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

export function resumeOf(
  { issue: forIssue, bench: row }: FoundTask,
  last: { agentSessionId: string; cwd: string },
): Launch {
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

export async function newRun(
  deps: BenchDeps,
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
export function refuseUnsendable(prompt: string | undefined) {
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
