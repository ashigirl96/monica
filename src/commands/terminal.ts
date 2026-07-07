import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  type AttachResult,
  type TerminalSession,
  type TerminalSessionKind,
} from "./bindings";

export type {
  AttachResult,
  TerminalRunspaceKind,
  TerminalSession,
  TerminalSessionKind,
  TerminalSessionStatus,
  TerminalStateSnapshot,
} from "./bindings";

import { unwrap } from "./unwrap";

export function terminalCreateSession(args: {
  runspaceId: string;
  tabId: string;
  kind: TerminalSessionKind;
  cwd: string;
  rows: number;
  cols: number;
  env?: [string, string][];
}): Promise<TerminalSession> {
  return unwrap(
    commands.terminalCreateSession(
      args.runspaceId,
      args.tabId,
      args.kind,
      args.cwd,
      args.rows,
      args.cols,
      args.env ?? null,
    ),
  );
}

export function terminalAttach(sessionId: string, replayBytes?: number): Promise<AttachResult> {
  return unwrap(commands.terminalAttach(sessionId, replayBytes ?? null));
}

export function terminalDetach(sessionId: string): Promise<void> {
  return unwrap(commands.terminalDetach(sessionId)).then(() => {});
}

export function terminalWrite(sessionId: string, data: string): Promise<void> {
  return unwrap(commands.terminalWrite(sessionId, data)).then(() => {});
}

export function terminalResize(sessionId: string, rows: number, cols: number): Promise<void> {
  return unwrap(commands.terminalResize(sessionId, rows, cols)).then(() => {});
}

export function terminalTerminate(sessionId: string): Promise<void> {
  return unwrap(commands.terminalTerminate(sessionId)).then(() => {});
}

export function terminalListSessions(runspaceId?: string): Promise<TerminalSession[]> {
  return unwrap(commands.terminalListSessions(runspaceId ?? null));
}

export function terminalLoadState(windowLabel: string) {
  return unwrap(commands.terminalLoadState(windowLabel));
}

export function terminalSaveState(
  windowLabel: string,
  state: Parameters<typeof commands.terminalSaveState>[1],
): Promise<void> {
  return unwrap(commands.terminalSaveState(windowLabel, state)).then(() => {});
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
