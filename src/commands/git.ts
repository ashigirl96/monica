import { commands } from "./bindings";

export type { WorktreeInfo } from "./bindings";

export async function worktreeInfo(cwd: string) {
  const result = await commands.worktreeInfo(cwd);
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}
