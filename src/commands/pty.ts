import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function ptySpawn(id: string, cwd: string, rows: number, cols: number): Promise<void> {
  return invoke("pty_spawn", { id, cwd, rows, cols });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, rows: number, cols: number): Promise<void> {
  return invoke("pty_resize", { id, rows, cols });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function onPtyOutput(id: string, cb: (data: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty:output:${id}`, (event) => cb(event.payload));
}

export type TerminalTabRow = {
  id: string;
  cwd: string;
  title: string;
  sort_order: number;
  is_active: boolean;
};

export type TerminalRunspaceRow = {
  id: string;
  sort_order: number;
  is_active: boolean;
  tabs: TerminalTabRow[];
};

export type TerminalStateSnapshot = {
  runspaces: TerminalRunspaceRow[];
};

export async function terminalLoadState(): Promise<TerminalStateSnapshot> {
  return invoke("terminal_load_state");
}

export async function terminalSaveState(state: TerminalStateSnapshot): Promise<void> {
  return invoke("terminal_save_state", { state });
}

export function onPtyExit(id: string, cb: (code: number | null) => void): Promise<UnlistenFn> {
  return listen<number | null>(`pty:exit:${id}`, (event) => cb(event.payload));
}
