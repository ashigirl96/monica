import { commands } from "./bindings";
import { unwrap } from "./unwrap";

export function resolveEditorPaths(cwd: string, candidates: string[]): Promise<(string | null)[]> {
  return commands.resolveEditorPaths(cwd, candidates);
}

export async function openInEditor(path: string): Promise<void> {
  await unwrap(commands.openInEditor(path));
}
