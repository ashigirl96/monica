import type { Db } from "@tania/workbench/server";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { ListItem } from "./contract.ts";
import { displayState } from "./display-state.ts";
import { formatRef } from "./ref.ts";
import { bench, issue, issueBlocker, task } from "./schema.ts";

export function listTasks(db: Db, { closed }: { closed: boolean }): ListItem[] {
  const rows = db
    .select({ task, issue, bench })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(closed ? isNotNull(task.closedAt) : isNull(task.closedAt))
    .orderBy(asc(task.trackedAt), asc(task.issueId))
    .all();
  const blocker = alias(issue, "blocker");
  const openBlockers = db
    .select({ issueId: issueBlocker.issueId, repo: blocker.repo, number: blocker.number })
    .from(issueBlocker)
    .innerJoin(blocker, eq(blocker.id, issueBlocker.blockerId))
    .where(
      and(
        inArray(
          issueBlocker.issueId,
          rows.map((row) => row.issue.id),
        ),
        eq(blocker.state, "open"),
      ),
    )
    .orderBy(asc(blocker.repo), asc(blocker.number))
    .all();
  return rows.map((row) => ({
    ref: formatRef(row.issue),
    title: row.issue.title,
    issueState: row.issue.state,
    blockers: openBlockers.filter((b) => b.issueId === row.issue.id).map(formatRef),
    cwd: row.bench?.cwd ?? null,
    displayState: displayState(row.task, row.issue, row.bench),
  }));
}
