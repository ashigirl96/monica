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
} from './terminal.ts'

// Module-level so StrictMode's double effects share one connection per tab.
export type TabConnection = {
  state: 'connecting' | 'attached' | 'dead'
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

// tab → the Terminal currently mounted for it. Session listeners and the in-flight
// connect outlive a React mount (StrictMode double-mounts), so writes must resolve the
// *current* instance instead of closing over one that may have been disposed — xterm
// throws renderer TypeErrors when written to after dispose.
const tabTerminals = new Map<string, Terminal>()

// WebGL で描いた Tab の文字は DOM に無いので、tauri-mcp で画面を確かめる dev のときだけ晒す。
if (import.meta.env.DEV) {
  ;(globalThis as { __monicaTerminals?: Map<string, Terminal> }).__monicaTerminals = tabTerminals
}

export function setTabTerminal(tabId: string, term: Terminal) {
  tabTerminals.set(tabId, term)
}

export function clearTabTerminal(tabId: string, term: Terminal) {
  if (tabTerminals.get(tabId) === term) tabTerminals.delete(tabId)
}

export function getTabTerminal(tabId: string): Terminal | undefined {
  return tabTerminals.get(tabId)
}

/// Drop the registry entry and its event listeners.
export function releaseTabConnection(tabId: string): void {
  const conn = tabConnections.get(tabId)
  if (!conn) return
  tabConnections.delete(tabId)
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
  { tabId, sessionId, onExit }: ConnectingTab,
  conn: TabConnection,
) {
  try {
    conn.sessionId = sessionId

    let live = false
    const pending: string[] = []
    // Await before reading conn.unlisteners: a release while subscribing replaces the array.
    const unlistenOutput = await onTerminalOutput(sessionId, (data) => {
      if (live) getTabTerminal(tabId)?.write(fromBase64(data))
      else pending.push(data)
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
    const term = getTabTerminal(tabId)
    if (term) {
      if (attach.replay) {
        // Queries recorded in the replay were already answered (or abandoned) when they
        // were live; answering them again would inject the responses into the shell's
        // stdin as command-line input. The write callback fires after the replay chunk
        // is parsed and before the pending (live) writes below, which keep responding.
        conn.replaying = true
        term.write(fromBase64(attach.replay), () => {
          conn.replaying = false
        })
      }
      live = true
      for (const data of pending) term.write(fromBase64(data))
      pending.length = 0
    } else {
      live = true
    }
    conn.state = 'attached'
    store.set(setTerminalSessionStatusAtom, sessionId, { status: 'running' })

    // The session was created, or last attached, at another size than this pane.
    if (term?.element && (term.rows !== attach.rows || term.cols !== attach.cols)) {
      void terminalResize(sessionId, term.rows, term.cols)
    }
  } catch (e) {
    console.warn(`terminal connect failed for tab ${tabId}:`, e)
    conn.state = 'dead'
    dropListeners(conn)
    // No pretend-reconnect: a session we cannot attach to is honestly lost.
    store.set(setTerminalSessionStatusAtom, sessionId, { status: 'lost' })
  } finally {
    conn.inFlight = undefined
  }
}
