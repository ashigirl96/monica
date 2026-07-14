import { atom } from "jotai";
import { worktreeInfo, type WorktreeInfo } from "@/commands/git";
import { tabDisplayPath, terminalStateAtom } from "@/features/work-bench/store";

// path → linked-worktree identity (null = not a worktree). The branch can change
// without a cwd change (`git switch` in place), so title updates re-resolve known
// paths instead of trusting the cache forever; the timestamp map throttles that
// against apps that rewrite the terminal title continuously.
export const worktreeInfoByPathAtom = atom<Record<string, WorktreeInfo | null>>({});

const WORKTREE_REVALIDATE_MS = 5000;
const worktreeResolvedAtAtom = atom<Record<string, number>>({});

export const resolveWorktreeInfoAtom = atom(null, async (get, set, revalidate?: string[]) => {
  const state = get(terminalStateAtom);
  if (!state) return;
  const cache = get(worktreeInfoByPathAtom);
  const resolvedAt = get(worktreeResolvedAtAtom);
  const now = Date.now();

  const paths = new Set<string>();
  for (const path of revalidate ?? []) {
    if (path.startsWith("/") && now - (resolvedAt[path] ?? 0) >= WORKTREE_REVALIDATE_MS) {
      paths.add(path);
    }
  }
  for (const rs of state.runspaces) {
    for (const tab of rs.tabs) {
      const path = tabDisplayPath(tab);
      if (path.startsWith("/") && !(path in cache)) paths.add(path);
    }
  }
  if (paths.size === 0) return;
  set(worktreeResolvedAtAtom, (prev) => {
    const next = { ...prev };
    for (const path of paths) next[path] = now;
    return next;
  });

  const entries = await Promise.all(
    [...paths].map(async (path) => [path, await worktreeInfo(path).catch(() => null)] as const),
  );
  set(worktreeInfoByPathAtom, (prev) => {
    const next = { ...prev };
    for (const [path, info] of entries) next[path] = info;
    return next;
  });
});
