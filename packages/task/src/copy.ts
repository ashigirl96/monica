import type { Tx } from "@tania/workbench/server";
import { and, eq, ne, sql } from "drizzle-orm";
import type { GitHubIssue, LinkedIssue } from "./github.ts";
import { formatRef, type IssueRef } from "./ref.ts";
import { issue, issueBlocker } from "./schema.ts";

export function isIssue({ repo, number }: IssueRef) {
  return and(eq(sql`lower(${issue.repo})`, repo.toLowerCase()), eq(issue.number, number));
}

/** `asked` は query に渡した ref。改名した repo でも旧名で引けるので、node ID の無い古い行をそれでも探す。 */
export function writeIssue(tx: Tx, copied: GitHubIssue, asked: IssueRef, syncedAt: Date): number {
  const parentId = copied.parent && writeLinkedIssue(tx, copied.parent, syncedAt);
  const copy = {
    title: copied.title,
    state: copied.state,
    labels: copied.labels,
    parentId,
    syncedAt,
  };
  const id = upsert(tx, copied, copy, copy, asked);
  tx.delete(issueBlocker).where(eq(issueBlocker.issueId, id)).run();
  const blockerIds = copied.blockers.map((blocker) => writeLinkedIssue(tx, blocker, syncedAt));
  if (blockerIds.length > 0) {
    tx.insert(issueBlocker)
      .values(blockerIds.map((blockerId) => ({ issueId: id, blockerId })))
      .run();
  }
  return id;
}

// その issue 自身が Task なら labels と parent はその Task の sync が書くので、ここでは触らない。
function writeLinkedIssue(tx: Tx, linked: LinkedIssue, syncedAt: Date): number {
  const { title, state } = linked;
  return upsert(
    tx,
    linked,
    { title, state, syncedAt },
    { title, state, labels: [], parentId: null, syncedAt },
  );
}

const rowRef = { id: issue.id, repo: issue.repo, number: issue.number };

function upsert(
  tx: Tx,
  { nodeId, repo, number }: LinkedIssue,
  update: Partial<typeof issue.$inferInsert>,
  insert: Omit<typeof issue.$inferInsert, "nodeId" | "repo" | "number">,
  asked?: IssueRef,
): number {
  const identity = { nodeId, repo, number };
  // Task の Issue は改名前の名前の行を先に見る。Task が指すのはその行だから。
  const existing =
    tx.select(rowRef).from(issue).where(eq(issue.nodeId, nodeId)).get() ??
    (asked && rowWithoutNodeId(tx, asked)) ??
    rowWithoutNodeId(tx, { repo, number });
  if (existing) {
    const other = tx
      .select({ id: issue.id })
      .from(issue)
      .where(and(isIssue({ repo, number }), ne(issue.id, existing.id)))
      .get();
    if (other) {
      throw new Error(
        `${formatRef(existing)} and ${formatRef({ repo, number })} are copies of the same issue`,
      );
    }
    tx.update(issue)
      .set({ ...identity, ...update })
      .where(eq(issue.id, existing.id))
      .run();
    return existing.id;
  }
  return tx
    .insert(issue)
    .values({ ...identity, ...insert })
    .returning({ id: issue.id })
    .get().id;
}

// node ID の無い行は node ID を足す前に書いた行。node ID が別なら、その番号は GitHub で別の issue に使われている。
function rowWithoutNodeId(tx: Tx, ref: IssueRef) {
  const row = tx
    .select({ ...rowRef, nodeId: issue.nodeId })
    .from(issue)
    .where(isIssue(ref))
    .get();
  if (row?.nodeId) throw new Error(`${formatRef(ref)} is now another issue on GitHub`);
  return row;
}
