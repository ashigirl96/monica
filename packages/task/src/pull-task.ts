import type { Db } from '@monica/workbench/server'
import { eq, type SQL } from 'drizzle-orm'

import { isIssue, isLinkedIssue } from './copy.ts'
import {
  findOpenTask,
  findTrackedTask,
  type FoundTask,
  refuseClosed,
  refuseOpen,
  TaskStateRefusal,
  taskIfTracked,
} from './open-task.ts'
import { formatRef, type IssueRef, parseRef } from './ref.ts'
import { issue } from './schema.ts'
import { SYNC_BEFORE_COMMAND_TIMEOUT_MS, type SyncDeps, syncTask, trackIssue } from './sync.ts'

/** Task に書く入口（run・press・attach・close・reopen）が Task を引く手順。いつ sync するかは入口が決める。 */

export type FoundOrTracked = { found: FoundTask; tracked: boolean }

type Reader = Pick<Db, 'select'>

export const isAsked = ({ nodeId, ...asked }: IssueRef & { nodeId?: string | null }) =>
  nodeId ? isLinkedIssue({ ...asked, nodeId }) : isIssue(asked)

/**
 * run・press・attach の引き方。未 track なら track し（ADR-0024）、closed なら reopen を案内して断る。
 * track は GitHub の今の名前で Task を書くので、改名前の名前で頼まれても track の返す ref で引き直す。
 * 呼び手が GitHub から node ID を引いてあれば、名前と番号が別の issue に移っていても取り違えない。
 */
export async function pullOrTrack(
  deps: SyncDeps,
  asked: IssueRef,
  nodeId?: string,
): Promise<FoundOrTracked> {
  const found = taskIfTracked(deps.db, isAsked({ ...asked, nodeId }))
  if (found) return { found: refuseClosed(found), tracked: false }
  const { ref, alreadyTracked } = await trackIssue(deps, formatRef(asked))
  return { found: findOpenTask(deps.db, isIssue(parseRef(ref)), ref), tracked: !alreadyTracked }
}

/** close の引き方。未 track は `NOT_FOUND`、closed は "already closed" で断る。close は予約の中でも引くので `tx` も受ける。 */
export function pullToClose(db: Reader, where: SQL | undefined, asked: string): FoundTask {
  const found = findTrackedTask(db, where, asked)
  if (found.task.closedAt) {
    throw new TaskStateRefusal('BAD_REQUEST', {
      message: `${formatRef(found.issue)} is already closed`,
    })
  }
  return found
}

/** reopen の引き方。未 track は `NOT_FOUND`、open は断る。 */
export function pullToReopen(db: Reader, where: SQL | undefined, asked: string): FoundTask {
  return refuseOpen(findTrackedTask(db, where, asked))
}

export type Pull = (db: Reader, where: SQL | undefined, asked: string) => FoundTask

export const pullOpen: Pull = findOpenTask

/** 状態で断らずに引く。reopen は sync の間に close が進んでも、断りを `writeClosedTask` の予約に任せる。 */
export const pullTracked: Pull = findTrackedTask

export type Refreshed = { found: FoundTask; warnings: string[] }

/**
 * Task を sync し、GitHub に届かなくても止めず、手元の写しで続けたことを warnings に残す。
 * sync は repo の改名を写すので、名前でなく行の id で、入口の引き方 `pull` で引き直す。
 */
export async function refresh(deps: SyncDeps, found: FoundTask, pull: Pull): Promise<Refreshed> {
  const copy = found.issue
  const { missing, failures } = await syncTask(deps, copy, SYNC_BEFORE_COMMAND_TIMEOUT_MS)
  const reasons = [...failures, ...missing.map((ref) => `GitHub did not return ${ref}`)]
  const minutes = Math.floor((Date.now() - copy.syncedAt.getTime()) / 60_000)
  const warnings =
    reasons.length === 0
      ? []
      : [
          `could not sync ${formatRef(copy)} from GitHub (${reasons.join('; ')}); using the copy from ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`,
        ]
  return { found: pull(deps.db, eq(issue.id, copy.id), formatRef(copy)), warnings }
}
