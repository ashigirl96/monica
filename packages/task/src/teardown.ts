import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Bench } from "./bench.ts";
import type { CloseRefusal } from "./contract.ts";
import { branchOf, checkoutOf, type Ghq, git, succeeds } from "./prepare.ts";
import type { IssueRef } from "./ref.ts";

export type InspectedWorktree = {
  path: string;
  branch: string;
  /** null なら checkout が無く、消すものも無い。 */
  checkout: string | null;
  present: boolean;
  branchExists: boolean;
  refusals: CloseRefusal[];
};

/** 失敗は 1 行の理由を message に持つ Error で投げる。 */
export async function inspectWorktree(
  ghq: Ghq,
  row: Pick<Bench, "cwd" | "branch">,
  forIssue: IssueRef,
): Promise<InspectedWorktree> {
  const path = row.cwd;
  const branch = row.branch ?? branchOf(forIssue);
  const present = existsSync(path);
  // repo が改名されても、作った worktree は作った時の checkout に登録されている。
  const checkout = present
    ? dirname(await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    : await checkoutOnDisk(ghq, forIssue.repo);
  if (!checkout) return { path, branch, checkout, present, branchExists: false, refusals: [] };
  const branchExists = await succeeds(
    git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`),
  );
  const refusals: CloseRefusal[] = [];
  if (present && (await git(path, "status", "--porcelain", "--untracked-files=normal")) !== "") {
    refusals.push({ kind: "uncommitted_changes" });
  }
  // fetch しないので、push した commit は merge されていなくても止めない。
  if (
    branchExists &&
    (await git(
      checkout,
      "rev-list",
      "--max-count=1",
      `refs/heads/${branch}`,
      "--not",
      "--remotes",
    )) !== ""
  ) {
    refusals.push({ kind: "unpublished_commits", branch });
  }
  return { path, branch, checkout, present, branchExists, refusals };
}

export async function removeWorktree({
  path,
  branch,
  checkout,
  present,
  branchExists,
}: InspectedWorktree) {
  if (!checkout) return { removedWorktree: null, deletedBranch: null };
  if (present) {
    await git(checkout, "worktree", "remove", "--force", path);
  } else {
    // 登録が残るとその branch を消せないので、関係の無い登録まで外す prune ではなく、この path の登録だけを外す。
    await succeeds(git(checkout, "worktree", "remove", "--force", path));
  }
  if (branchExists) await git(checkout, "branch", "-D", branch);
  return { removedWorktree: present ? path : null, deletedBranch: branchExists ? branch : null };
}

async function checkoutOnDisk(ghq: Ghq, repo: string): Promise<string | null> {
  const checkout = await checkoutOf(ghq, repo);
  return existsSync(checkout) ? checkout : null;
}
