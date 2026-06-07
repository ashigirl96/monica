import { invoke } from "@tauri-apps/api/core";

export async function clipboardWriteImage(path: string): Promise<void> {
  return invoke("clipboard_write_image", { path });
}
