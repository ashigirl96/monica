/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { GithubPullRequestRef, TaskSummaryRow } from "@/commands/task";
import { issueUrl, openTargets } from "@/features/work-board/github-urls";

function pr(over: Partial<GithubPullRequestRef>): GithubPullRequestRef {
  return {
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    status: "open",
    is_open_or_draft: true,
    ...over,
  };
}

function task(over: Partial<TaskSummaryRow>): TaskSummaryRow {
  return {
    id: "t1",
    title: "task",
    project: "owner/repo",
    github_issue_number: null,
    github_pull_requests: [],
    task_status: "ready",
    task_run_status: null,
    task_run_wait_reason: null,
    status: "ready",
    prepare_eligible: false,
    run_eligible: false,
    is_active: false,
    has_open_pull_request: false,
    branch: null,
    side_runs_running: 0,
    side_runs_waiting_for_user: 0,
    side_runs_failed: 0,
    ...over,
  } as TaskSummaryRow;
}

describe("issueUrl", () => {
  test("builds the url from project and number", () => {
    expect(issueUrl("owner/repo", 42)).toBe("https://github.com/owner/repo/issues/42");
  });

  test("null project yields null", () => {
    expect(issueUrl(null, 42)).toBeNull();
  });

  test("null number yields null", () => {
    expect(issueUrl("owner/repo", null)).toBeNull();
  });
});

describe("openTargets", () => {
  test("no issue and no pr yields an empty list", () => {
    expect(openTargets(task({}))).toEqual([]);
  });

  test("issue only", () => {
    expect(openTargets(task({ github_issue_number: 7 }))).toEqual([
      { id: "issue", kind: "issue", number: 7, url: "https://github.com/owner/repo/issues/7" },
    ]);
  });

  test("issue first, then open/draft prs ahead of the rest and number descending within a group", () => {
    const result = openTargets(
      task({
        github_issue_number: 7,
        github_pull_requests: [
          pr({ number: 10, status: "merged", is_open_or_draft: false }),
          pr({ number: 11, status: "closed", is_open_or_draft: false }),
          pr({ number: 12, status: "open", is_open_or_draft: true }),
          pr({ number: 13, status: "draft", is_open_or_draft: true }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["issue", "pr:13", "pr:12", "pr:11", "pr:10"]);
  });

  test("prs without a url are excluded", () => {
    const result = openTargets(
      task({
        github_pull_requests: [pr({ number: 1, url: null }), pr({ number: 2 })],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["pr:2"]);
  });

  test("issue is dropped when the url cannot be built but prs remain", () => {
    const result = openTargets(
      task({ project: null, github_issue_number: 7, github_pull_requests: [pr({ number: 3 })] }),
    );
    expect(result.map((t) => t.id)).toEqual(["pr:3"]);
  });
});
