import { commands } from "./bindings";
import { unwrap } from "./unwrap";

export type { WorktreeInfo } from "./bindings";

export function worktreeInfo(cwd: string) {
  return unwrap(commands.worktreeInfo(cwd));
}
