import { commands } from "./bindings";
import { unwrap } from "./unwrap";

export async function clipboardWriteImage(path: string): Promise<void> {
  await unwrap(commands.clipboardWriteImage(path));
}
