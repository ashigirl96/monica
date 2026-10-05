import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { shell } from './shell.ts'

export type AttachResult = { replay: string; rows: number; cols: number }

export function terminalAttach(sessionId: string, replayBytes?: number): Promise<AttachResult> {
  return shell('terminal_attach', { sessionId, replayBytes: replayBytes ?? null })
}

export function terminalDetach(sessionId: string): Promise<void> {
  return shell('terminal_detach', { sessionId })
}

// Shell は command を別々の thread で走らせ順番を保たないので、書き込みと resize は前の 1 つが届いてから送る。
const lastSends = new Map<string, Promise<void>>()

function inOrder(sessionId: string, command: string, args: Record<string, unknown>) {
  const previous = lastSends.get(sessionId) ?? Promise.resolve()
  const sent = previous.then(() => shell<void>(command, { sessionId, ...args }))
  const settled = sent.catch(() => {})
  lastSends.set(sessionId, settled)
  void settled.then(() => {
    if (lastSends.get(sessionId) === settled) lastSends.delete(sessionId)
  })
  return sent
}

export function terminalWrite(sessionId: string, data: string): Promise<void> {
  return inOrder(sessionId, 'terminal_write', { data })
}

export function terminalResize(sessionId: string, rows: number, cols: number): Promise<void> {
  return inOrder(sessionId, 'terminal_resize', { rows, cols })
}

export function onTerminalOutput(
  sessionId: string,
  cb: (data: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`terminal:output:${sessionId}`, (event) => cb(event.payload))
}

export function onTerminalExit(
  sessionId: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(`terminal:exit:${sessionId}`, (event) => cb(event.payload))
}
