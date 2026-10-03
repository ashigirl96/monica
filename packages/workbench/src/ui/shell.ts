import { invoke } from "@tauri-apps/api/core";

// Shell の command は失敗を文字列で返すので、呼び手が message を読めるよう Error に包む。
export function shell<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}
