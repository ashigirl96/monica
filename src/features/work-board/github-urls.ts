import type { TaskSummaryRow } from "@/commands/task";

export type OpenTarget =
  | { id: "issue"; kind: "issue"; number: number; url: string }
  | {
      id: string;
      kind: "pr";
      number: number;
      status: string | null;
      isOpenOrDraft: boolean;
      url: string;
    };

export function openTargets(task: TaskSummaryRow): OpenTarget[] {
  const targets: OpenTarget[] = [];

  if (task.github_issue_url !== null && task.github_issue_number !== null) {
    targets.push({
      id: "issue",
      kind: "issue",
      number: task.github_issue_number,
      url: task.github_issue_url,
    });
  }

  // open/draft PRs are the ones a reader usually wants, so they sort ahead of the rest;
  // within each group the newest (highest number) comes first. The open/draft predicate
  // itself lives in Rust (is_open_or_draft).
  const prs = task.github_pull_requests
    .filter(
      (pr): pr is typeof pr & { url: string; number: number } =>
        pr.url !== null && pr.number !== null,
    )
    .sort((a, b) => Number(b.is_open_or_draft) - Number(a.is_open_or_draft) || b.number - a.number);
  for (const pr of prs) {
    targets.push({
      id: `pr:${pr.number}`,
      kind: "pr",
      number: pr.number,
      status: pr.status,
      isOpenOrDraft: pr.is_open_or_draft,
      url: pr.url,
    });
  }

  return targets;
}
