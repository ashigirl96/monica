import type { Terminal } from '@xterm/xterm'
import type { Store } from 'jotai'

import { encoder } from './base64.ts'
import { connectTab, tabConnectionsAtom } from './terminal-connections.ts'
import { terminalSessionStatusAtom } from './terminal-sessions.ts'
import { type AttachResult, type TerminalPort, terminalPortAtom } from './terminal.ts'

export type ShellCall =
  | { command: 'attach'; sessionId: string }
  | { command: 'write'; sessionId: string; data: string }
  | { command: 'resize'; sessionId: string; rows: number; cols: number }

type Hold = { gate: Promise<void>; arrived: () => void }

const decoder = new TextDecoder()

function listener<T>(listeners: Map<string, T>, sessionId: string, cb: T) {
  listeners.set(sessionId, cb)
  return () => {
    if (listeners.get(sessionId) === cb) listeners.delete(sessionId)
  }
}

// ptyd の代役なので、Terminal Session ごとに replay を持ち、出力と Exit を好きな時に流せる。
export function fakeTerminalPort(store: Store) {
  const calls: ShellCall[] = []
  const replays = new Map<string, string>()
  const outputs = new Map<string, (data: Uint8Array) => void>()
  const exits = new Map<string, (code: number | null) => void>()
  const holds = new Map<keyof TerminalPort, Hold>()
  const waiters: { count: number; resolve: () => void }[] = []

  function record(call: ShellCall) {
    calls.push(call)
    for (const waiter of waiters.filter((w) => calls.length >= w.count)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  async function pass(method: keyof TerminalPort) {
    const held = holds.get(method)
    if (!held) return
    holds.delete(method)
    held.arrived()
    await held.gate
  }

  const port: TerminalPort = {
    async attach(sessionId): Promise<AttachResult> {
      await pass('attach')
      record({ command: 'attach', sessionId })
      return { replay: encoder.encode(replays.get(sessionId) ?? ''), rows: 24, cols: 80 }
    },
    async write(sessionId, data) {
      await pass('write')
      record({ command: 'write', sessionId, data: decoder.decode(data) })
    },
    async resize(sessionId, rows, cols) {
      await pass('resize')
      record({ command: 'resize', sessionId, rows, cols })
    },
    async onOutput(sessionId, cb) {
      await pass('onOutput')
      return listener(outputs, sessionId, cb)
    },
    async onExit(sessionId, cb) {
      await pass('onExit')
      return listener(exits, sessionId, cb)
    },
  }

  store.set(terminalPortAtom, port)
  return {
    calls,
    replays,
    received(count: number): Promise<void> {
      if (calls.length >= count) return Promise.resolve()
      return new Promise((resolve) => waiters.push({ count, resolve }))
    },
    hold(method: keyof TerminalPort) {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      holds.set(method, { gate: gate.promise, arrived: reached.resolve })
      return {
        reached: reached.promise,
        release: () => gate.resolve(),
        fail: (error: Error) => gate.reject(error),
      }
    },
    output(sessionId: string, text: string) {
      outputs.get(sessionId)?.(encoder.encode(text))
    },
    exit(sessionId: string, code: number | null) {
      exits.get(sessionId)?.(code)
    },
    listening(): string[] {
      return [
        ...[...outputs.keys()].map((s) => `output:${s}`),
        ...[...exits.keys()].map((s) => `exit:${s}`),
      ]
    },
  }
}

// xterm は DOM が要るので、書き込みを記録して replay の parse の終わりを手で知らせる object で代える。
export function mountFakeTerminal(store: Store, tabId: string) {
  const written: string[] = []
  const parsed: (() => void)[] = []
  const term = {
    rows: 24,
    cols: 80,
    write(data: Uint8Array, callback?: () => void) {
      written.push(decoder.decode(data))
      if (callback) parsed.push(callback)
    },
  }
  const unmount = store.get(tabConnectionsAtom).mount(tabId, term as unknown as Terminal)
  return { term, written, parsed, unmount }
}

// pane と同じく、読み直した status で attach してよいかを決める。
export function connectAsPane(store: Store, tabId: string, sessionId: string) {
  const status = store.get(terminalSessionStatusAtom)[sessionId]?.status
  return connectTab(store, { tabId, sessionId, status })
}
