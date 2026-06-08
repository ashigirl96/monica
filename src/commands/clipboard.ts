import { commands } from "./bindings";

export async function clipboardWriteImage(path: string): Promise<void> {
  const result = await commands.clipboardWriteImage(path);
  if (result.status === "error") throw new Error(result.error);
}
