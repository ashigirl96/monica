import { commands } from "./bindings";

export function resolveEditorPaths(cwd: string, candidates: string[]): Promise<(string | null)[]> {
  return commands.resolveEditorPaths(cwd, candidates);
}

export async function openInEditor(path: string): Promise<void> {
  const result = await commands.openInEditor(path);
  if (result.status === "error") throw new Error(result.error);
}
