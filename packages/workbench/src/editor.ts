import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function resolveEditorPaths(cwd: string, candidates: string[]): Promise<(string | null)[]> {
  return Promise.all(candidates.map((candidate) => resolveEditorPath(cwd, candidate.trim())));
}

async function resolveEditorPath(cwd: string, candidate: string): Promise<string | null> {
  const found = await existingPath(cwd, candidate);
  if (found !== null) return found;
  // 端末は `path:line:col` の形で出すことが多い。
  const withoutPosition = candidate.replace(/(?::\d+){1,2}$/, "");
  return withoutPosition === candidate ? null : existingPath(cwd, withoutPosition);
}

async function existingPath(cwd: string, candidate: string): Promise<string | null> {
  if (!candidate) return null;
  const expanded =
    candidate === "~"
      ? homedir()
      : candidate.startsWith("~/")
        ? join(homedir(), candidate.slice(2))
        : candidate;
  return realpath(isAbsolute(expanded) ? expanded : join(cwd, expanded)).catch(() => null);
}

export async function openInEditor(path: string): Promise<void> {
  const open = Bun.spawn(["/usr/bin/open", "-a", "Zed", path], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(open.stderr).text(), open.exited]);
  if (exitCode !== 0) throw new Error(`open -a Zed exited with ${exitCode}: ${stderr.trim()}`);
}
