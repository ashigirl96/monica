import type { UnlistenFn } from '@tauri-apps/api/event'
import type { Terminal } from '@xterm/xterm'
import type { Store } from 'jotai'

import { layoutAtom } from './backend-copy.ts'
import { encoder, fromBase64, toBase64 } from './base64.ts'
import {
  canAttach,
  setTerminalSessionStatusAtom,
  type TerminalSessionStatus,
} from './terminal-sessions.ts'
import {
  onTerminalExit,
  onTerminalOutput,
  terminalAttach,
  terminalResize,
  terminalWrite,
  registerRenderer,
  rendererParsed,
  removeRenderer,
  type RendererGeneration,
} from './terminal.ts'

// The mounted renderer owns one connection per Tab.
export type TabConnection = {
  state: 'connecting' | 'attached' | 'dead'
  generation?: RendererGeneration
  ready?: boolean
  parsed?: number
  sessionId?: string
  inFlight?: Promise<void>
  unlisteners: UnlistenFn[]
  // While the attach replay is being parsed, xterm answers terminal queries recorded in
  // the Terminal Session Transcript (DA, OSC 10/11, kitty); those responses must not
  // reach the live PTY.
  replaying?: boolean
}

const tabConnections = new Map<string, TabConnection>()

export function getTabConnection(tabId: string): TabConnection | undefined {
  return tabConnections.get(tabId)
}

export function openTabConnection(tabId: string): TabConnection {
  const conn: TabConnection = { state: 'connecting', unlisteners: [] }
  tabConnections.set(tabId, conn)
  return conn
}

// Resolve the mounted instance before applying asynchronous output.
const tabTerminals = new Map<string, Terminal>()

// WebGL で描いた Tab の文字は DOM に無いので、tauri-mcp で画面を確かめる dev のときだけ晒す。
if (import.meta.env.DEV) {
  ;(globalThis as { __monicaTerminals?: Map<string, Terminal> }).__monicaTerminals = tabTerminals
}

export function setTabTerminal(tabId: string, term: Terminal) {
  tabTerminals.set(tabId, term)
}

export function clearTabTerminal(tabId: string, term: Terminal) {
  if (tabTerminals.get(tabId) === term) {
    tabTerminals.delete(tabId)
    releaseTabConnection(tabId)
  }
}

export function getTabTerminal(tabId: string): Terminal | undefined {
  return tabTerminals.get(tabId)
}

/// Drop the registry entry and its event listeners.
export function releaseTabConnection(tabId: string): void {
  const conn = tabConnections.get(tabId)
  if (!conn) return
  tabConnections.delete(tabId)
  if (conn.sessionId && conn.generation) void removeRenderer(conn.sessionId, conn.generation)
  for (const unlisten of conn.unlisteners) unlisten()
  // The connect error path also unlistens whatever is left; clearing here keeps a
  // release racing that path from double-invoking the same UnlistenFns.
  conn.unlisteners = []
}

// CLI の tab close や Task の close は webview を通らないので、読み直した Layout に無い Tab の接続をここで release する。
export function releaseTabsLeavingLayout(store: Store): () => void {
  return store.sub(layoutAtom, () => {
    const tabIds = new Set(store.get(layoutAtom)?.runspaces.flatMap((r) => r.tabs.map((t) => t.id)))
    for (const tabId of tabConnections.keys()) {
      if (!tabIds.has(tabId)) releaseTabConnection(tabId)
    }
  })
}

// replay の中の問い合わせには出された時に答え済みなので、xterm がもう一度答えた分は shell に送らない。
export function replyToShell(tabId: string, text: string): void {
  const conn = tabConnections.get(tabId)
  if (conn?.sessionId && !conn.replaying)
    void terminalWrite(conn.sessionId, toBase64(encoder.encode(text)))
}

/// dispose() drops xterm's write queue, so a replay write callback may never fire; unstick
/// the mute or the remounted terminal would silently drop all replies.
export function endReplay(tabId: string): void {
  const conn = tabConnections.get(tabId)
  if (conn) conn.replaying = false
}

type ConnectingTab = {
  tabId: string
  sessionId: string
  status?: TerminalSessionStatus
  hidden?: boolean
  onExit: (exitCode: number | null) => void
}

/// Returns whether the Tab is already attached to `sessionId`, so the pane only has to
/// resize it. A connection to an earlier session (respawn) is released first; a dead one
/// is retried only once the status says the session can be attached again.
export function connectTab(store: Store, tab: ConnectingTab): boolean {
  let conn = tabConnections.get(tab.tabId)
  if (conn && conn.sessionId !== tab.sessionId) {
    releaseTabConnection(tab.tabId)
    conn = undefined
  }
  if (conn?.state === 'attached') return true
  if (!conn?.inFlight && canAttach(tab.status)) {
    // inFlight must be set before the first await, or an effect re-run mid-connect
    // (StrictMode's double run, or the session status arriving) starts a second connect.
    const opened = openTabConnection(tab.tabId)
    opened.inFlight = runConnect(store, tab, opened)
  }
  return false
}

// A release racing this connect empties conn.unlisteners; anything subscribed after that
// point is only reachable from here.
function dropListeners(conn: TabConnection) {
  for (const unlisten of conn.unlisteners) unlisten()
  conn.unlisteners = []
}

/// subscribe → attach → replay → flush. Output arriving between subscribe and replay-write
/// is buffered, and the daemon only emits post-attach output, so the stream is gapless
/// without sequence numbers.
async function runConnect(
  store: Store,
  { tabId, sessionId, onExit, hidden }: ConnectingTab,
  conn: TabConnection,
) {
  try {
    conn.sessionId = sessionId

    const term = getTabTerminal(tabId)
    conn.generation = await registerRenderer(sessionId)
    if (tabConnections.get(tabId) !== conn || getTabTerminal(tabId) !== term) {
      if (conn.generation) void removeRenderer(sessionId, conn.generation)
      return
    }
    let live = false
    const pending: { data: string; sequence: number }[] = []
    const parsed = (sequence: number) => {
      if (tabConnections.get(tabId) !== conn || getTabTerminal(tabId) !== term) return
      conn.parsed = sequence
      heartbeatRenderer(tabId)
    }
    const write = (data: string, sequence: number) =>
      term?.write(fromBase64(data), () => parsed(sequence))
    // Await before reading conn.unlisteners: a release while subscribing replaces the array.
    const unlistenOutput = await onTerminalOutput(sessionId, (data, progress) => {
      const sequence =
        progress?.generation.renderer === conn.generation?.renderer &&
        progress?.generation.connection === conn.generation?.connection
          ? (progress?.sequence ?? 0)
          : 0
      if (live) write(data, sequence)
      else pending.push({ data, sequence })
    })
    conn.unlisteners.push(unlistenOutput)
    const unlistenExit = await onTerminalExit(sessionId, onExit)
    conn.unlisteners.push(unlistenExit)

    // Released while subscribing or attaching: the Tab closed or moved to a new shell, and
    // its session is ending, so nothing here may write into the pane.
    if (tabConnections.get(tabId) !== conn) {
      dropListeners(conn)
      return
    }

    const attach = await terminalAttach(sessionId)
    if (tabConnections.get(tabId) !== conn) {
      dropListeners(conn)
      return
    }
    // No reset before the replay: the terminal here is always a freshly mounted (empty)
    // instance — the connection guard prevents double-attach — and Terminal.reset()
    // corrupts the WebGL renderer (blank canvas, "this._renderer.value.dimensions"
    // TypeErrors) once WebglAddon is loaded.
    if (term) {
      if (hidden) term.resize(attach.cols, attach.rows)
      if (attach.replay) {
        // Queries recorded in the replay were already answered (or abandoned) when they
        // were live; answering them again would inject the responses into the shell's
        // stdin as command-line input. The write callback fires after the replay chunk
        // is parsed and before the pending (live) writes below, which keep responding.
        conn.replaying = true
        term.write(fromBase64(attach.replay), () => {
          if (tabConnections.get(tabId) !== conn || getTabTerminal(tabId) !== term) return
          conn.replaying = false
          conn.ready = true
          heartbeatRenderer(tabId)
        })
      }
      if (!attach.replay) conn.ready = true
      live = true
      for (const { data, sequence } of pending) write(data, sequence)
      heartbeatRenderer(tabId)
      pending.length = 0
    } else {
      live = true
    }
    conn.state = 'attached'
    store.set(setTerminalSessionStatusAtom, sessionId, { status: 'running' })

    // The session was created, or last attached, at another size than this pane.
    if (!hidden && term?.element && (term.rows !== attach.rows || term.cols !== attach.cols)) {
      void terminalResize(sessionId, term.rows, term.cols)
    }
  } catch (e) {
    console.warn(`terminal connect failed for tab ${tabId}:`, e)
    if (tabConnections.get(tabId) !== conn) return
    conn.state = 'dead'
    dropListeners(conn)
    // No pretend-reconnect: a session we cannot attach to is honestly lost.
    store.set(setTerminalSessionStatusAtom, sessionId, { status: 'lost' })
  } finally {
    conn.inFlight = undefined
  }
}

export function heartbeatRenderer(tabId: string): void {
  const conn = tabConnections.get(tabId)
  if (conn?.ready && conn.sessionId && conn.generation && getTabTerminal(tabId)) {
    void rendererParsed(conn.sessionId, conn.generation, conn.parsed ?? 0).catch(() => {})
  }
}
