import type { Db } from '@monica/workbench/server'
import { eq, type SQL } from 'drizzle-orm'

import { isIssue, isLinkedIssue } from './copy.ts'
import {
  type FoundTask,
  findTrackedTask,
  refuseAlreadyClosed,
  refuseClosed,
  refuseOpen,
  taskIfTracked,
} from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { issue } from './schema.ts'
import { SYNC_BEFORE_COMMAND_TIMEOUT_MS, type SyncDeps, syncTask, trackIssue } from './sync.ts'

/** Task に書く入口ごとに、どの状態の Task を断るか。 */
export type Entry = 'run' | 'close' | 'reopen'

export type FoundOrTracked = { found: FoundTask; tracked: boolean }

export type Refreshed = { found: FoundTask; warnings: string[] }

export function findTask(
  db: Pick<Db, 'select'>,
  where: SQL | undefined,
  asked: string,
  entry: Entry,
): FoundTask {
  return refuseState(findTrackedTask(db, where, asked), entry)
}

// track は GitHub の今の名前で Task を書くので、改名前の名前で頼まれても track の返す ref で引き直す。
// 呼び手が GitHub から node ID を引いてあれば、名前と番号が別の issue に移っていても取り違えない。
export async function findOrTrack(
  deps: SyncDeps,
  asked: IssueRef,
  nodeId?: string,
): Promise<FoundOrTracked> {
  const found = taskIfTracked(deps.db, isAsked({ ...asked, nodeId }))
  if (found) return { found: refuseState(found, 'run'), tracked: false }
  const { ref, alreadyTracked } = await trackIssue(deps, formatRef(asked))
  return { found: findTask(deps.db, isIssue(parseRef(ref)), ref, 'run'), tracked: !alreadyTracked }
}

export const isAsked = ({ nodeId, ...asked }: IssueRef & { nodeId?: string | null }) =>
  nodeId ? isLinkedIssue({ ...asked, nodeId }) : isIssue(asked)

// sync は repo の改名を写すので、名前でなく行の id で引き直す。
export async function refreshTask(
  deps: SyncDeps,
  found: FoundTask,
  entry?: Entry,
): Promise<Refreshed> {
  const warnings = await syncOrUseCopy(deps, found.issue)
  const again = findTrackedTask(deps.db, eq(issue.id, found.issue.id), formatRef(found.issue))
  return { found: entry ? refuseState(again, entry) : again, warnings }
}

// GitHub に届かなくても止めず、手元の写しで続けたことを警告に残す。
async function syncOrUseCopy(
  deps: SyncDeps,
  copy: IssueRef & { syncedAt: Date },
): Promise<string[]> {
  const { missing, failures } = await syncTask(deps, copy, SYNC_BEFORE_COMMAND_TIMEOUT_MS)
  const reasons = [...failures, ...missing.map((ref) => `GitHub did not return ${ref}`)]
  if (reasons.length === 0) return []
  const minutes = Math.floor((Date.now() - copy.syncedAt.getTime()) / 60_000)
  return [
    `could not sync ${formatRef(copy)} from GitHub (${reasons.join('; ')}); using the copy from ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`,
  ]
}

function refuseState(found: FoundTask, entry: Entry): FoundTask {
  switch (entry) {
    case 'run':
      return refuseClosed(found)
    case 'close':
      return refuseAlreadyClosed(found)
    case 'reopen':
      return refuseOpen(found)
  }
}
