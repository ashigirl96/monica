import type { UnlistenFn } from '@tauri-apps/api/event'
import type { Terminal } from '@xterm/xterm'
import { atom, getDefaultStore, type Store } from 'jotai'

import { layoutAtom } from './backend-copy.ts'
import { encoder } from './base64.ts'
import {
  canAttach,
  markEndedAtom,
  setTerminalSessionStatusAtom,
  type TerminalSessionStatus,
} from './terminal-sessions.ts'
import { terminalPortAtom, type TerminalPort } from './terminal.ts'

type TabConnection = {
  state: 'connecting' | 'attached' | 'dead'
  sessionId: string
  inFlight?: Promise<void>
  unlisteners: UnlistenFn[]
  // While the attach replay is being parsed, xterm answers terminal queries recorded in
  // the Terminal Session Transcript (DA, OSC 10/11, kitty); those responses must not
  // reach the live PTY.
  replaying?: boolean
}

export type ConnectingTab = {
  tabId: string
  sessionId: string
  status?: TerminalSessionStatus
  onStatus: (status: 'running' | 'lost') => void
  onExit: () => void
}

export type TabConnections = ReturnType<typeof createTabConnections>

function createTabConnections(port: TerminalPort) {
  const connections = new Map<string, TabConnection>()
  // tab → the Terminal currently mounted for it. Session listeners and the in-flight
  // connect outlive a React mount (StrictMode double-mounts), so writes must resolve the
  // *current* instance instead of closing over one that may have been disposed — xterm
  // throws renderer TypeErrors when written to after dispose.
  const terminals = new Map<string, Terminal>()

  // Shell は command を別々の thread で走らせ順番を保たないので、書き込みと resize は前の 1 つが届いてから送る。
  const lastSends = new Map<string, Promise<void>>()
  function inOrder(sessionId: string, deliver: () => Promise<void>) {
    const previous = lastSends.get(sessionId) ?? Promise.resolve()
    const settled = previous.then(deliver).catch(() => {})
    lastSends.set(sessionId, settled)
    void settled.then(() => {
      if (lastSends.get(sessionId) === settled) lastSends.delete(sessionId)
    })
  }

  function send(tabId: string, data: string | Uint8Array) {
    const conn = connections.get(tabId)
    if (!conn || conn.state === 'dead') return
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    inOrder(conn.sessionId, () => port.write(conn.sessionId, bytes))
  }

  function resizeSession(sessionId: string, term: Terminal) {
    const { rows, cols } = term
    inOrder(sessionId, () => port.resize(sessionId, rows, cols))
  }

  // A release racing this connect empties conn.unlisteners; anything subscribed after that
  // point is only reachable from here.
  function dropListeners(conn: TabConnection) {
    for (const unlisten of conn.unlisteners) unlisten()
    conn.unlisteners = []
  }

  function release(tabId: string): void {
    const conn = connections.get(tabId)
    if (!conn) return
    connections.delete(tabId)
    // The connect error path also unlistens whatever is left; clearing here keeps a
    // release racing that path from double-invoking the same UnlistenFns.
    dropListeners(conn)
  }

  /// subscribe → attach → replay → flush. Output arriving between subscribe and replay-write
  /// is buffered, and the daemon only emits post-attach output, so the stream is gapless
  /// without sequence numbers.
  async function runConnect(
    { tabId, sessionId, onStatus, onExit }: ConnectingTab,
    conn: TabConnection,
  ) {
    try {
      let live = false
      const pending: Uint8Array[] = []
      // Await before reading conn.unlisteners: a release while subscribing replaces the array.
      const unlistenOutput = await port.onOutput(sessionId, (data) => {
        if (live) terminals.get(tabId)?.write(data)
        else pending.push(data)
      })
      conn.unlisteners.push(unlistenOutput)
      const unlistenExit = await port.onExit(sessionId, onExit)
      conn.unlisteners.push(unlistenExit)

      // Released while subscribing or attaching: the Tab closed or moved to a new shell, and
      // its session is ending, so nothing here may write into the pane.
      if (connections.get(tabId) !== conn) {
        dropListeners(conn)
        return
      }

      const attach = await port.attach(sessionId)
      if (connections.get(tabId) !== conn) {
        dropListeners(conn)
        return
      }
      // No reset before the replay: the terminal here is always a freshly mounted (empty)
      // instance — the connection guard prevents double-attach — and Terminal.reset()
      // corrupts the WebGL renderer (blank canvas, "this._renderer.value.dimensions"
      // TypeErrors) once WebglAddon is loaded.
      const term = terminals.get(tabId)
      if (term) {
        if (attach.replay.length > 0) {
          // Queries recorded in the replay were already answered (or abandoned) when they
          // were live; answering them again would inject the responses into the shell's
          // stdin as command-line input. The write callback fires after the replay chunk
          // is parsed and before the pending (live) writes below, which keep responding.
          conn.replaying = true
          term.write(attach.replay, () => {
            conn.replaying = false
          })
        }
        live = true
        for (const data of pending) term.write(data)
        pending.length = 0
      } else {
        live = true
      }
      conn.state = 'attached'
      onStatus('running')

      // The session was created, or last attached, at another size than this pane.
      if (term?.element && (term.rows !== attach.rows || term.cols !== attach.cols)) {
        resizeSession(sessionId, term)
      }
    } catch (e) {
      console.warn(`terminal connect failed for tab ${tabId}:`, e)
      conn.state = 'dead'
      dropListeners(conn)
      // No pretend-reconnect: a session we cannot attach to is honestly lost.
      onStatus('lost')
    } finally {
      conn.inFlight = undefined
    }
  }

  return {
    terminals,

    /// Returns whether the Tab is already attached to `sessionId`, so the pane only has to
    /// resize it. A connection to an earlier session (respawn) is released first; a dead one
    /// is retried only once the status says the session can be attached again.
    connect(tab: ConnectingTab): boolean {
      let conn = connections.get(tab.tabId)
      if (conn && conn.sessionId !== tab.sessionId) {
        release(tab.tabId)
        conn = undefined
      }
      if (conn?.state === 'attached') return true
      if (!conn?.inFlight && canAttach(tab.status)) {
        // inFlight must be set before the first await, or an effect re-run mid-connect
        // (StrictMode's double run, or the session status arriving) starts a second connect.
        const opened: TabConnection = {
          state: 'connecting',
          sessionId: tab.sessionId,
          unlisteners: [],
        }
        connections.set(tab.tabId, opened)
        opened.inFlight = runConnect(tab, opened)
      }
      return false
    },

    release,

    tabIds(): string[] {
      return [...connections.keys()]
    },

    releaseUnbound(bound: ReadonlyMap<string, string>): void {
      for (const [tabId, conn] of connections) {
        if (bound.get(tabId) !== conn.sessionId) release(tabId)
      }
    },

    mount(tabId: string, term: Terminal): () => void {
      terminals.set(tabId, term)
      return () => {
        if (terminals.get(tabId) === term) terminals.delete(tabId)
        // dispose() drops xterm's write queue, so a replay write callback may never fire;
        // unstick the mute or the remounted terminal would silently drop all replies.
        const conn = connections.get(tabId)
        if (conn) conn.replaying = false
      }
    },

    terminal(tabId: string): Terminal | undefined {
      return terminals.get(tabId)
    },

    /// 接続が無いか lost の Tab への入力は、届ける相手が無いので捨てる。
    input: send,

    // replay の中の問い合わせには出された時に答え済みなので、xterm がもう一度答えた分は shell に送らない。
    reply(tabId: string, text: string): void {
      if (!connections.get(tabId)?.replaying) send(tabId, text)
    },

    resize(tabId: string): void {
      const conn = connections.get(tabId)
      const term = terminals.get(tabId)
      if (conn && conn.state !== 'dead' && term) resizeSession(conn.sessionId, term)
    },
  }
}

// store ごとに 1 つなので、StrictMode の 2 度の effect も同じ Tab に同じ接続を見る。
export const tabConnectionsAtom = atom((get) => createTabConnections(get(terminalPortAtom)))

// WebGL で描いた Tab の文字は DOM に無いので、tauri-mcp で画面を確かめる dev のときだけ晒す。
if (import.meta.env.DEV) {
  ;(globalThis as { __monicaTerminals?: Map<string, Terminal> }).__monicaTerminals =
    getDefaultStore().get(tabConnectionsAtom).terminals
}

function boundSessions(store: Store): Map<string, string> {
  return new Map(
    store
      .get(layoutAtom)
      ?.runspaces.flatMap((r) => r.tabs.map((t) => [t.id, t.terminalSessionId] as const)),
  )
}

// 閉じるか張り直すかは Backend が決める。張り直しが先に届いた Tab はもう新しい shell を指しているので触らない。
function tabExited(store: Store, tabId: string, sessionId: string) {
  if (boundSessions(store).get(tabId) !== sessionId) return
  store.get(tabConnectionsAtom).release(tabId)
  store.set(markEndedAtom, sessionId)
}

export function connectTab(store: Store, tab: Omit<ConnectingTab, 'onStatus' | 'onExit'>): boolean {
  return store.get(tabConnectionsAtom).connect({
    ...tab,
    onStatus: (status) => store.set(setTerminalSessionStatusAtom, tab.sessionId, { status }),
    onExit: () => tabExited(store, tab.tabId, tab.sessionId),
  })
}

// CLI の tab close や Task の close は webview を通らず、見えていない Tab の張り直しには pane の connect が走らないので、読み直した Layout が同じ Terminal Session に結んでいない Tab Connection をここで release する。
export function releaseTabsLeavingLayout(store: Store): () => void {
  return store.sub(layoutAtom, () =>
    store.get(tabConnectionsAtom).releaseUnbound(boundSessions(store)),
  )
}
