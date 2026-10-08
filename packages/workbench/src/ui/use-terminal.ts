import { openUrl } from '@tauri-apps/plugin-opener'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'

import '@xterm/xterm/css/xterm.css'
import { getDefaultStore } from 'jotai'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { fromBase64, encoder, toBase64 } from './base64.ts'
import { EventCleanupManager } from './event-cleanup.ts'
import { pasteFilePaths } from './file-paste.ts'
import { jumpHintsActiveAtom } from './jump-hints.ts'
import { terminalFocusRequestAtom } from './navigation.ts'
import { openInEditorAtom, resolveEditorPathsAtom } from './store.ts'
import { attachTapSelection } from './tap-selection.ts'
import {
  clearTabTerminal,
  getTabConnection,
  getTabTerminal,
  openTabConnection,
  releaseTabConnection,
  setTabTerminal,
  type TabConnection,
} from './terminal-connections.ts'
import { attachTerminalLinks } from './terminal-links.ts'
import {
  canAttach,
  type TerminalSessionStatus,
  setTerminalSessionStatusAtom,
} from './terminal-sessions.ts'
import {
  buildKeyEventHandler,
  createWheelHandler,
  onTerminalData,
  registerParsers,
  TERMINAL_THEME,
} from './terminal-setup.ts'
import { terminalFontSizeAtom, zoomTerminalAtom } from './terminal-zoom.ts'
import {
  onTerminalExit,
  onTerminalOutput,
  terminalAttach,
  terminalResize,
  terminalWrite,
} from './terminal.ts'
import { webglRendererPool } from './webgl-renderer.ts'

function fitAndResize(fit: FitAddon, term: Terminal, sessionId: string): void {
  // A display:none pane has no box to measure — fitting it could clamp the grid to
  // FitAddon's 2x1 minimum and shrink the PTY under a running TUI. It refits on
  // activation instead.
  if (term.element && term.element.getClientRects().length === 0) return
  const { rows, cols } = term
  fit.fit()
  // fit() also no-ops for size changes too small to move the grid; the PTY already
  // has these dimensions, so skip the resize round-trip.
  if (term.rows !== rows || term.cols !== cols) {
    void terminalResize(sessionId, term.rows, term.cols)
  }
}

type UseTerminalOptions = {
  tabId: string
  sessionId: string
  sessionStatus?: TerminalSessionStatus
  cwd: string
  active: boolean
  onTitleChange?: (title: string) => void
  onCwdChange?: (cwd: string) => void
  onExit: (sessionId: string, exitCode: number | null) => void
}

// A release racing this connect empties conn.unlisteners; anything subscribed after that
// point is only reachable from here.
function dropListeners(conn: TabConnection) {
  for (const unlisten of conn.unlisteners) unlisten()
  conn.unlisteners = []
}

/// Attach the tab's session: subscribe → attach → replay → flush. Output arriving between
/// subscribe and replay-write is buffered, and the daemon only emits post-attach output, so
/// the stream is gapless without sequence numbers.
/// Synchronous wrapper: inFlight must be set before the first await, or an effect re-run
/// mid-connect (e.g. StrictMode's double run, or the session status arriving) starts a
/// second connect.
function connectTab(optionsRef: React.RefObject<UseTerminalOptions>) {
  const { tabId } = optionsRef.current
  const conn = openTabConnection(tabId)
  conn.inFlight = runConnect(optionsRef, conn)
}

async function runConnect(optionsRef: React.RefObject<UseTerminalOptions>, conn: TabConnection) {
  const store = getDefaultStore()
  const { tabId, sessionId } = optionsRef.current
  try {
    conn.sessionId = sessionId

    let live = false
    const pending: string[] = []
    conn.unlisteners.push(
      await onTerminalOutput(sessionId, (data) => {
        if (live) getTabTerminal(tabId)?.write(fromBase64(data))
        else pending.push(data)
      }),
    )
    conn.unlisteners.push(
      await onTerminalExit(sessionId, (code) => optionsRef.current.onExit(sessionId, code)),
    )

    // Released while subscribing or attaching: the Tab closed or moved to a new shell, and
    // its session is ending, so nothing here may write into the pane.
    if (getTabConnection(tabId) !== conn) {
      dropListeners(conn)
      return
    }

    const attach = await terminalAttach(sessionId)
    if (getTabConnection(tabId) !== conn) {
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

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions,
) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const openedRef = useRef(false)
  const optionsRef = useRef(options)
  // Layout effects run before the passive effects below, which read this ref in the same commit.
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    const store = getDefaultStore()
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', monospace",
      fontSize: store.get(terminalFontSizeAtom),
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: false,
      allowProposedApi: true,
      scrollback: 5000,
      // ghostty の default_word_boundaries に揃えた語境界集合。
      wordSeparator: ' \t\'"│`|:;,()[]{}<>$',
      // マウスレポート中の TUI でも修飾キーでローカル選択を許可する (mac は Option)。
      macOptionClickForcesSelection: true,
      // OSC 8 ハイパーリンクも regex リンクと同様 cmd 押下時のみ発火させる (ghostty 準拠)。
      linkHandler: {
        activate: (event, uri) => {
          if (event.metaKey) void openUrl(uri)
        },
      },
      theme: TERMINAL_THEME,
      // claude は TERM_PROGRAM=WezTerm を見て kitty の flag を push し、Ctrl+V と Shift+Enter を kitty の形でしか読まない。
      vtExtensions: { kittyKeyboard: true },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new Unicode11Addon())

    termRef.current = term
    fitRef.current = fitAddon
    setTabTerminal(options.tabId, term)

    const cleanup = new EventCleanupManager()

    const sendBytes = (bytes: Uint8Array) => {
      void terminalWrite(optionsRef.current.sessionId, toBase64(bytes))
    }
    const writeText = (text: string) => sendBytes(encoder.encode(text))
    // replay の中の問い合わせには出された時に答え済みなので、xterm がもう一度答えた分は shell に送らない。
    const writeReply = (text: string) => {
      if (!getTabConnection(options.tabId)?.replaying) writeText(text)
    }

    onTerminalData(term, { input: writeText, reply: writeReply })

    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i)
      }
      sendBytes(bytes)
    })

    term.onTitleChange((title) => {
      optionsRef.current.onTitleChange?.(title)
    })

    registerParsers(term, () => optionsRef.current.onCwdChange)

    term.attachCustomKeyEventHandler(
      buildKeyEventHandler(
        () => store.get(jumpHintsActiveAtom),
        (delta: 1 | -1) => store.set(zoomTerminalAtom, delta),
        () => term.selectAll(),
      ),
    )

    function blockPhantom(e: Event) {
      if (e instanceof MouseEvent && e.buttons === 0) {
        e.stopPropagation()
        e.preventDefault()
      }
    }

    const onWheel = createWheelHandler(term, writeText)

    const container = containerRef.current
    if (container) {
      cleanup.addEventListener(container, 'mousedown', blockPhantom, true)
      cleanup.addEventListener(container, 'pointerdown', blockPhantom, true)
      cleanup.addEventListener(container, 'wheel', onWheel, { capture: true })
      // xterm は paste を textarea と element で受けるので、その手前の capture で横取りする。
      cleanup.addEventListener(
        container,
        'paste',
        (e) => void pasteFilePaths(e, (text) => term.paste(text)),
        true,
      )
      cleanup.add(attachTapSelection(term, container))
      cleanup.add(
        attachTerminalLinks(term, container, {
          resolve: (candidates) =>
            store.set(resolveEditorPathsAtom, optionsRef.current.cwd, candidates),
          open: (path) => store.set(openInEditorAtom, path),
        }),
      )
    }

    const unsubFontSize = store.sub(terminalFontSizeAtom, () => {
      const size = store.get(terminalFontSizeAtom)
      term.options.fontSize = size
      if (openedRef.current && fitRef.current) {
        fitAndResize(fitRef.current, term, optionsRef.current.sessionId)
      }
    })
    cleanup.add(unsubFontSize)

    return () => {
      // The tab connection (session listeners) deliberately survives unmount/remount;
      // it is released by the store when the tab closes or starts a new shell. The
      // terminal registry entry must go first so in-flight writes stop resolving to a
      // disposed instance.
      clearTabTerminal(options.tabId, term)
      // dispose() drops xterm's write queue, so a replay write callback may never fire;
      // unstick the mute or the remounted terminal would silently drop all input.
      const conn = getTabConnection(options.tabId)
      if (conn) conn.replaying = false
      // Release before disposeAll: the pool must not keep a GL context alive because
      // an unrelated listener cleanup threw.
      webglRendererPool.release(term)
      cleanup.disposeAll()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      openedRef.current = false
    }
  }, [options.tabId, containerRef])

  // Sessions are attached only when shown, so their replay is sized to the pane.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    const container = containerRef.current
    if (!term || !fit || !container || !options.active) return

    if (!openedRef.current) {
      term.open(container)
      openedRef.current = true
    }

    fit.fit()

    let conn = getTabConnection(options.tabId)
    // The Tab was bound to a new Terminal Session (respawn); the old one has ended.
    if (conn && conn.sessionId !== options.sessionId) {
      releaseTabConnection(options.tabId)
      conn = undefined
    }
    // A dead session never reconnects; the pane overlay offers a fresh shell instead. A
    // starting one is attached when the status turns running and reruns this effect.
    if (!conn?.inFlight && conn?.state !== 'attached' && canAttach(options.sessionStatus)) {
      connectTab(optionsRef)
    }

    if (conn?.state === 'attached') {
      void terminalResize(options.sessionId, term.rows, term.cols)
    }
    term.focus()

    const observer = new ResizeObserver(() => {
      if (fitDebounce) clearTimeout(fitDebounce)
      fitDebounce = window.setTimeout(() => {
        fitAndResize(fit, term, optionsRef.current.sessionId)
      }, 100)
    })

    let fitDebounce: number | undefined
    observer.observe(container)

    return () => {
      observer.disconnect()
      if (fitDebounce) clearTimeout(fitDebounce)
    }
  }, [options.active, options.tabId, options.sessionId, options.sessionStatus, containerRef])

  // Activation only acquires; the pane keeps its WebGL renderer after deactivation
  // until the pool LRU-evicts it, so hopping between recent tabs skips the expensive
  // renderer swap. Deps deliberately exclude session/cwd so those changes don't churn
  // the addon. The open effect above runs first in the same commit, so the terminal is
  // always opened here.
  useEffect(() => {
    if (!options.active) return
    const term = termRef.current
    if (!term || !openedRef.current) return
    webglRendererPool.acquire(term)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the term is rebuilt per tabId, and the rebuilt one needs a renderer too.
  }, [options.active, options.tabId, containerRef])

  useEffect(() => {
    if (!options.active) return
    return getDefaultStore().sub(terminalFocusRequestAtom, () => {
      termRef.current?.focus()
    })
  }, [options.active])

  return termRef
}
