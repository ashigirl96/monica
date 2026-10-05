import type { Db, Tx } from '@tania/workbench/server'
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { GitHubIssue, LinkedIssue } from './github.ts'
import { formatRef, type IssueRef } from './ref.ts'
import { issue, issueBlocker } from './schema.ts'

export function isIssue({ repo, number }: IssueRef) {
  return and(eq(sql`lower(${issue.repo})`, repo.toLowerCase()), eq(issue.number, number))
}

export function openBlockersOf(db: Db, issueIds: number[]) {
  const blocker = alias(issue, 'blocker')
  return db
    .select({ issueId: issueBlocker.issueId, repo: blocker.repo, number: blocker.number })
    .from(issueBlocker)
    .innerJoin(blocker, eq(blocker.id, issueBlocker.blockerId))
    .where(and(inArray(issueBlocker.issueId, issueIds), eq(blocker.state, 'open')))
    .orderBy(asc(blocker.repo), asc(blocker.number))
    .all()
}

/**
 * repo の issue の写しを書く。`askedRepo` は query に渡した repo で、改名前の名前のこともある。
 * Task の Issue の行に先に node ID と今の名前を付け、parent や Blocker として先に出てきても Task の行に当たるようにする。
 */
export function writeIssues(
  tx: Tx,
  copied: GitHubIssue[],
  askedRepo: string,
  syncedAt: Date,
): number[] {
  const ids = copied.map((one) =>
    upsert(
      tx,
      one,
      {},
      { title: one.title, state: one.state, labels: one.labels, parentId: null, syncedAt },
      { repo: askedRepo, number: one.number },
    ),
  )
  copied.forEach((one, i) => writeCopy(tx, ids[i]!, one, syncedAt))
  return ids
}

function writeCopy(tx: Tx, id: number, copied: GitHubIssue, syncedAt: Date) {
  const parentId = copied.parent && writeLinkedIssue(tx, copied.parent, syncedAt)
  const { title, state, labels } = copied
  tx.update(issue).set({ title, state, labels, parentId, syncedAt }).where(eq(issue.id, id)).run()
  tx.delete(issueBlocker).where(eq(issueBlocker.issueId, id)).run()
  const blockerIds = copied.blockers.map((blocker) => writeLinkedIssue(tx, blocker, syncedAt))
  if (blockerIds.length > 0) {
    tx.insert(issueBlocker)
      .values(blockerIds.map((blockerId) => ({ issueId: id, blockerId })))
      .run()
  }
}

// その issue 自身が Task なら labels と parent はその Task の sync が書くので、ここでは触らない。
function writeLinkedIssue(tx: Tx, linked: LinkedIssue, syncedAt: Date): number {
  const { title, state } = linked
  return upsert(
    tx,
    linked,
    { title, state, syncedAt },
    { title, state, labels: [], parentId: null, syncedAt },
  )
}

const rowRef = { id: issue.id, repo: issue.repo, number: issue.number }

function upsert(
  tx: Tx,
  { nodeId, repo, number }: LinkedIssue,
  update: Partial<typeof issue.$inferInsert>,
  insert: Omit<typeof issue.$inferInsert, 'nodeId' | 'repo' | 'number'>,
  asked?: IssueRef,
): number {
  const identity = { nodeId, repo, number }
  // Task の Issue は query に渡した ref の行を先に見る。Task が指すのはその行だから。
  const existing =
    (asked && copyAt(tx, asked, nodeId)) ??
    tx.select(rowRef).from(issue).where(eq(issue.nodeId, nodeId)).get() ??
    copyAt(tx, { repo, number }, nodeId)
  if (existing) {
    const other = tx
      .select(rowRef)
      .from(issue)
      .where(
        and(or(eq(issue.nodeId, nodeId), isIssue({ repo, number })), ne(issue.id, existing.id)),
      )
      .get()
    if (other) {
      throw new Error(`${formatRef(existing)} and ${formatRef(other)} are copies of the same issue`)
    }
    tx.update(issue)
      .set({ ...identity, ...update })
      .where(eq(issue.id, existing.id))
      .run()
    return existing.id
  }
  return tx
    .insert(issue)
    .values({ ...identity, ...insert })
    .returning({ id: issue.id })
    .get().id
}

// node ID の無い行は node ID を足す前に書いた行。node ID が別なら、その番号は GitHub で別の issue に使われている。
function copyAt(tx: Tx, ref: IssueRef, nodeId: string) {
  const row = tx
    .select({ ...rowRef, nodeId: issue.nodeId })
    .from(issue)
    .where(isIssue(ref))
    .get()
  if (row?.nodeId && row.nodeId !== nodeId) {
    throw new Error(`${formatRef(ref)} is now another issue on GitHub`)
  }
  return row
}
