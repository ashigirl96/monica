/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { GithubPullRequestRef } from "@/commands/task";
import { openTargets } from "@/lib/github-targets";
import { taskSummary as task } from "@/features/work-board/test-fixtures";

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

describe("openTargets", () => {
  test("no issue and no pr yields an empty list", () => {
    expect(openTargets(task({}))).toEqual([]);
  });

  test("issue only", () => {
    expect(
      openTargets(
        task({
          github_issue_number: 7,
          github_issue_url: "https://github.com/owner/repo/issues/7",
        }),
      ),
    ).toEqual([
      { id: "issue", kind: "issue", number: 7, url: "https://github.com/owner/repo/issues/7" },
    ]);
  });

  test("issue first, then open/draft prs ahead of the rest and number descending within a group", () => {
    const result = openTargets(
      task({
        github_issue_number: 7,
        github_issue_url: "https://github.com/owner/repo/issues/7",
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

  test("prs without a number are excluded", () => {
    const result = openTargets(
      task({
        github_pull_requests: [
          pr({ number: null, url: "https://github.com/owner/repo/pull/0" }),
          pr({ number: 2 }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["pr:2"]);
  });

  test("issue is dropped when the backend supplies no url but prs remain", () => {
    const result = openTargets(
      task({
        github_issue_number: 7,
        github_issue_url: null,
        github_pull_requests: [pr({ number: 3 })],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["pr:3"]);
  });
});
