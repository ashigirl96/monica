import { openUrl } from '@tauri-apps/plugin-opener'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'

import '@xterm/xterm/css/xterm.css'
import { getDefaultStore } from 'jotai'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { encoder, toBase64 } from './base64.ts'
import { EventCleanupManager } from './event-cleanup.ts'
import { pasteFilePaths } from './file-paste.ts'
import { keymap } from './keys.ts'
import { terminalFocusRequestAtom } from './navigation.ts'
import { openInEditorAtom, resolveEditorPathsAtom } from './store.ts'
import { attachTapSelection } from './tap-selection.ts'
import {
  clearTabTerminal,
  connectTab,
  endReplay,
  replyToShell,
  setTabTerminal,
  heartbeatRenderer,
} from './terminal-connections.ts'
import { attachTerminalLinks } from './terminal-links.ts'
import type { TerminalSessionStatus } from './terminal-sessions.ts'
import {
  buildKeyEventHandler,
  createWheelHandler,
  onTerminalData,
  registerParsers,
  TERMINAL_THEME,
} from './terminal-setup.ts'
import { terminalFontSizeAtom, zoomTerminalAtom } from './terminal-zoom.ts'
import { onRendererRequest, terminalResize, terminalWrite } from './terminal.ts'
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
      // ①のような East Asian Ambiguous の文字は 1 cell に置かれるが、fallback の和文 font が全角で描くので、縮めて隣と重ねない（縮め方は patches/ の addon-webgl）。
      rescaleOverlappingGlyphs: true,
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

    onTerminalData(term, { input: writeText, reply: (text) => replyToShell(options.tabId, text) })

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
        (e) => keymap.takesFromTerminal(store, e),
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

    let disposed = false
    const prepare = (sessionId: string) => {
      if (disposed || sessionId !== optionsRef.current.sessionId || !container) return
      if (!openedRef.current) {
        term.open(container)
        openedRef.current = true
      }
      connectTab(store, {
        tabId: options.tabId,
        sessionId,
        status: optionsRef.current.sessionStatus,
        hidden: !optionsRef.current.active,
        onExit: (code) => optionsRef.current.onExit(sessionId, code),
      })
    }
    void onRendererRequest(prepare).then((unlisten) => {
      if (disposed) unlisten()
      else cleanup.add(unlisten)
    })
    const heartbeat = setInterval(() => heartbeatRenderer(options.tabId), 2000)
    cleanup.add(() => clearInterval(heartbeat))

    const unsubFontSize = store.sub(terminalFontSizeAtom, () => {
      const size = store.get(terminalFontSizeAtom)
      term.options.fontSize = size
      if (openedRef.current && fitRef.current) {
        fitAndResize(fitRef.current, term, optionsRef.current.sessionId)
      }
    })
    cleanup.add(unsubFontSize)

    return () => {
      disposed = true
      clearTabTerminal(options.tabId, term)
      endReplay(options.tabId)
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

    // A dead session never reconnects; the pane overlay offers a fresh shell instead. A
    // starting one is attached when the status turns running and reruns this effect.
    const sessionId = options.sessionId
    const attached = connectTab(getDefaultStore(), {
      tabId: options.tabId,
      sessionId,
      status: options.sessionStatus,
      onExit: (code) => optionsRef.current.onExit(sessionId, code),
    })
    if (attached) void terminalResize(sessionId, term.rows, term.cols)
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
