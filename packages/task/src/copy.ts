import type { Tx } from "@tania/workbench/server";
import { and, eq, sql } from "drizzle-orm";
import type { GitHubIssue, LinkedIssue } from "./github.ts";
import type { IssueRef } from "./ref.ts";
import { issue, issueBlocker } from "./schema.ts";

export function isIssue({ repo, number }: IssueRef) {
  return and(eq(sql`lower(${issue.repo})`, repo.toLowerCase()), eq(issue.number, number));
}

function findIssue(tx: Tx, ref: IssueRef) {
  return tx.select().from(issue).where(isIssue(ref)).get();
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

// repo の綴りは最初に書いたときのまま残す。rename で別の綴りになると UNIQUE(repo, number) の既存の行とぶつかりうる。
function upsert(
  tx: Tx,
  ref: IssueRef,
  update: Partial<typeof issue.$inferInsert>,
  insert: Omit<typeof issue.$inferInsert, "repo" | "number">,
): number {
  const existing = findIssue(tx, ref);
  if (existing) {
    tx.update(issue).set(update).where(eq(issue.id, existing.id)).run();
    return existing.id;
  }
  return tx
    .insert(issue)
    .values({ repo: ref.repo, number: ref.number, ...insert })
    .returning({ id: issue.id })
    .get().id;
}
