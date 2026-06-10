import { commands } from "./bindings";

export async function openRunspaceWindow(cwd: string): Promise<void> {
  const result = await commands.openRunspaceWindow(cwd);
  if (result.status === "error") throw new Error(result.error);
}
