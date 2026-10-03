import { basename, dirname } from "node:path";
import type { Worktree } from "./contract.ts";

export async function worktreeInfo(cwd: string): Promise<Worktree | null> {
  const git = Bun.spawn(
    [
      "git",
      "-C",
      cwd,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [stdout, exitCode] = await Promise.all([new Response(git.stdout).text(), git.exited]);
  if (exitCode !== 0) return null;
  const [branch, gitDir, commonDir] = stdout.split("\n");
  // main の checkout では 2 つが同じ directory を指し、linked worktree でだけ分かれる。
  if (!branch || !gitDir || !commonDir || gitDir === commonDir) return null;
  return { repo: basename(dirname(commonDir)), branch };
}
