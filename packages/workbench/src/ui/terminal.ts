import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { atom } from 'jotai'

import { fromBase64, toBase64 } from './base64.ts'
import { shell } from './shell.ts'

export type AttachResult = { replay: Uint8Array; rows: number; cols: number }

export type TerminalPort = {
  attach(sessionId: string): Promise<AttachResult>
  write(sessionId: string, data: Uint8Array): Promise<void>
  resize(sessionId: string, rows: number, cols: number): Promise<void>
  onOutput(sessionId: string, cb: (data: Uint8Array) => void): Promise<UnlistenFn>
  onExit(sessionId: string, cb: (code: number | null) => void): Promise<UnlistenFn>
}

export const tauriTerminalPort: TerminalPort = {
  async attach(sessionId) {
    const attached = await shell<{ replay: string; rows: number; cols: number }>(
      'terminal_attach',
      { sessionId, replayBytes: null },
    )
    return { ...attached, replay: fromBase64(attached.replay) }
  },
  write: (sessionId, data) => shell('terminal_write', { sessionId, data: toBase64(data) }),
  resize: (sessionId, rows, cols) => shell('terminal_resize', { sessionId, rows, cols }),
  onOutput: (sessionId, cb) =>
    listen<string>(`terminal:output:${sessionId}`, (event) => cb(fromBase64(event.payload))),
  onExit: (sessionId, cb) =>
    listen<number | null>(`terminal:exit:${sessionId}`, (event) => cb(event.payload)),
}

export const terminalPortAtom = atom<TerminalPort>(tauriTerminalPort)
