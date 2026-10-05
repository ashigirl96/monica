import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, fakeGhq, git } from "./fake-ghq.ts";
import { inspectWorktree, removeWorktree } from "./teardown.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const forIssue = { repo: "acme/app", number: 12 };

async function inspectedClean() {
  const scratch = mkdtempSync(join(tmpdir(), "tania-teardown-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const ghq = fakeGhq(scratch);
  ghq.origin("acme/app");
  ghq.clone("acme/app");
  const checkout = ghq.checkout("acme/app");
  const path = join(scratch, "worktree");
  git(checkout, "worktree", "add", "--quiet", "-b", "issue-12", path, "origin/main");
  const inspected = await inspectWorktree(ghq.client, { cwd: path, branch: "issue-12" }, forIssue);
  expect(inspected.refusals).toEqual([]);
  return { checkout, path, inspected };
}

function hasBranch(checkout: string, branch: string): boolean {
  return Bun.spawnSync(
    ["git", "-C", checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { env: process.env },
  ).success;
}

test("without force, changes written to the worktree after it was inspected stop the removal, and the files stay", async () => {
  const { checkout, path, inspected } = await inspectedClean();
  writeFileSync(join(path, "late.txt"), "late\n");

  await expect(removeWorktree(inspected, { force: false })).rejects.toThrow(
    "git worktree remove failed",
  );

  expect(existsSync(join(path, "late.txt"))).toBe(true);
  expect(hasBranch(checkout, "issue-12")).toBe(true);
});

test("without force, commits on no remote made after the inspection keep the branch, with a warning", async () => {
  const { checkout, inspected, path } = await inspectedClean();
  commit(path, { "late.txt": { content: "late\n" } }, "late");

  expect(await removeWorktree(inspected, { force: false })).toEqual({
    removedWorktree: path,
    deletedBranch: null,
    warnings: ["branch issue-12 got commits on no remote while closing, so it stays"],
  });
  expect(existsSync(path)).toBe(false);
  expect(hasBranch(checkout, "issue-12")).toBe(true);
});

test("with force, the worktree and the branch go whatever was written after the inspection", async () => {
  const { checkout, path, inspected } = await inspectedClean();
  commit(path, { "late.txt": { content: "late\n" } }, "late");
  writeFileSync(join(path, "draft.txt"), "draft\n");

  expect(await removeWorktree(inspected, { force: true })).toEqual({
    removedWorktree: path,
    deletedBranch: "issue-12",
    warnings: [],
  });
  expect(existsSync(path)).toBe(false);
  expect(hasBranch(checkout, "issue-12")).toBe(false);
});
