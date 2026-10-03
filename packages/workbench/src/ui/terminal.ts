import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AttachResult = { replay: string; rows: number; cols: number };

// Shell の command は失敗を文字列で返すので、呼び手が message を読めるよう Error に包む。
function shell<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

export function terminalAttach(sessionId: string, replayBytes?: number): Promise<AttachResult> {
  return shell("terminal_attach", { sessionId, replayBytes: replayBytes ?? null });
}

export function terminalDetach(sessionId: string): Promise<void> {
  return shell("terminal_detach", { sessionId });
}

export function terminalWrite(sessionId: string, data: string): Promise<void> {
  return shell("terminal_write", { sessionId, data });
}

export function terminalResize(sessionId: string, rows: number, cols: number): Promise<void> {
  return shell("terminal_resize", { sessionId, rows, cols });
}

export function onTerminalOutput(
  sessionId: string,
  cb: (data: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`terminal:output:${sessionId}`, (event) => cb(event.payload));
}

export function onTerminalExit(
  sessionId: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(`terminal:exit:${sessionId}`, (event) => cb(event.payload));
}
