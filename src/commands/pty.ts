import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "./bindings";

export type { TerminalStateSnapshot } from "./bindings";

async function unwrap<T>(
  result: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export function ptySpawn(
  id: string,
  cwd: string,
  rows: number,
  cols: number,
  env: [string, string][] = [],
): Promise<void> {
  return unwrap(commands.ptySpawn(id, cwd, env, rows, cols)).then(() => {});
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return unwrap(commands.ptyWrite(id, data)).then(() => {});
}

export function ptyResize(id: string, rows: number, cols: number): Promise<void> {
  return unwrap(commands.ptyResize(id, rows, cols)).then(() => {});
}

export function ptyKill(id: string): Promise<void> {
  return unwrap(commands.ptyKill(id)).then(() => {});
}

export function terminalLoadState() {
  return unwrap(commands.terminalLoadState());
}

export function terminalSaveState(
  state: Parameters<typeof commands.terminalSaveState>[0],
): Promise<void> {
  return unwrap(commands.terminalSaveState(state)).then(() => {});
}

export function onPtyOutput(id: string, cb: (data: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty:output:${id}`, (event) => cb(event.payload));
}

export function onPtyExit(id: string, cb: (code: number | null) => void): Promise<UnlistenFn> {
  return listen<number | null>(`pty:exit:${id}`, (event) => cb(event.payload));
}
