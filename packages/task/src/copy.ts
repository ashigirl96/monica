import type { Tx } from "@tania/workbench/server";
import { and, eq, sql } from "drizzle-orm";
import type { GitHubIssue, LinkedIssue } from "./github.ts";
import type { IssueRef } from "./ref.ts";
import { issue, issueBlocker } from "./schema.ts";

export function isIssue({ repo, number }: IssueRef) {
  return and(eq(sql`lower(${issue.repo})`, repo.toLowerCase()), eq(issue.number, number));
}

export function writeIssue(tx: Tx, copied: GitHubIssue, syncedAt: Date): number {
  const parentId = copied.parent && writeLinkedIssue(tx, copied.parent, syncedAt);
  const copy = {
    title: copied.title,
    state: copied.state,
    labels: copied.labels,
    parentId,
    syncedAt,
  };
  const id = upsert(tx, copied, copy, copy);
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

function upsert(
  tx: Tx,
  { nodeId, repo, number }: LinkedIssue,
  update: Partial<typeof issue.$inferInsert>,
  insert: Omit<typeof issue.$inferInsert, "nodeId" | "repo" | "number">,
): number {
  const identity = { nodeId, repo, number };
  const existing =
    tx.select({ id: issue.id }).from(issue).where(eq(issue.nodeId, nodeId)).get() ??
    tx.select({ id: issue.id }).from(issue).where(isIssue({ repo, number })).get();
  if (existing) {
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
