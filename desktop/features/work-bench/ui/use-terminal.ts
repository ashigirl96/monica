import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { EventCleanupManager } from "@/lib/event-cleanup";
import { toBase64, fromBase64, encoder } from "@/lib/base64";
import { attachTapSelection } from "@/features/work-bench/ui/tap-selection";
import { attachTerminalLinks } from "@/features/work-bench/ui/terminal-links";
import { webglRendererPool } from "@/features/work-bench/ui/webgl-renderer";
import {
  TERMINAL_THEME,
  registerParsers,
  buildKeyEventHandler,
  createWheelHandler,
} from "@/features/work-bench/ui/terminal-setup";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getDefaultStore } from "jotai";
import {
  onTerminalExit,
  onTerminalOutput,
  terminalAttach,
  terminalCreateSession,
  terminalDetach,
  terminalResize,
  terminalTerminate,
  terminalWrite,
  type TerminalSessionStatus,
} from "@/commands/terminal";
import { activeSpaceAtom } from "@/stores/space";
import { terminalFocusRequestAtom, type TerminalLaunchIntent } from "@/features/work-bench/store";
import { jumpHintsActiveAtom } from "@/features/work-bench/jump-hints";
import { setSessionStatusAtom } from "@/features/work-bench/session-status";
import { terminalFontSizeAtom, zoomTerminalAtom } from "@/features/work-bench/terminal-zoom";
import {
  clearTabTerminal,
  getTabConnection,
  getTabTerminal,
  openTabConnection,
  releaseTabConnection,
  setTabTerminal,
  type TabConnection,
} from "@/features/work-bench/terminal-connections";

function isDeadStatus(status: TerminalSessionStatus | undefined): boolean {
  return status === "exited" || status === "lost" || status === "failed";
}

function fitAndResize(
  fit: FitAddon,
  term: Terminal,
  sessionIdRef: { current: string | null },
): void {
  // A display:none pane has no box to measure — fitting it could clamp the grid to
  // FitAddon's 2x1 minimum and shrink the PTY under a running TUI. It refits on
  // activation instead.
  if (term.element && term.element.getClientRects().length === 0) return;
  const { rows, cols } = term;
  fit.fit();
  // fit() also no-ops for size changes too small to move the grid; the PTY already
  // has these dimensions, so skip the resize round-trip.
  if (sessionIdRef.current && (term.rows !== rows || term.cols !== cols)) {
    terminalResize(sessionIdRef.current, term.rows, term.cols);
  }
}

type UseTerminalOptions = {
  tabId: string;
  runspaceId: string;
  sessionId?: string;
  sessionStatus?: TerminalSessionStatus;
  cwd: string;
  active: boolean;
  env?: [string, string][];
  launch?: TerminalLaunchIntent;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onLaunchConsumed?: () => void;
  onExit?: () => void;
};

// A release racing this connect empties conn.unlisteners; anything subscribed after that
// point is only reachable from here.
function dropListeners(conn: TabConnection) {
  for (const unlisten of conn.unlisteners) unlisten();
  conn.unlisteners = [];
}

/// Create the tab's session if needed, then attach: subscribe → attach → replay → flush.
/// Output arriving between subscribe and replay-write is buffered, and the daemon only
/// emits post-attach output, so the stream is gapless without sequence numbers.
/// Synchronous wrapper: inFlight must be set before the first await, or a re-render
/// mid-connect (e.g. the shell's first OSC7 cwd report) starts a second connect.
function connectTab(
  optionsRef: React.RefObject<UseTerminalOptions>,
  sessionIdRef: React.RefObject<string | null>,
) {
  const { tabId } = optionsRef.current;
  const conn = openTabConnection(tabId);
  conn.inFlight = runConnect(optionsRef, sessionIdRef, conn);
}

async function runConnect(
  optionsRef: React.RefObject<UseTerminalOptions>,
  sessionIdRef: React.RefObject<string | null>,
  conn: TabConnection,
) {
  const store = getDefaultStore();
  const { tabId } = optionsRef.current;
  let sessionId = optionsRef.current.sessionId;
  const isNew = !sessionId;
  try {
    // An unopened (background) terminal reports xterm's default grid here; the PTY follows
    // the fitted size once the pane is shown.
    const created = getTabTerminal(tabId);
    const createdRows = created?.rows ?? 24;
    const createdCols = created?.cols ?? 80;
    if (!sessionId) {
      const options = optionsRef.current;
      const session = await terminalCreateSession({
        runspaceId: options.runspaceId,
        tabId,
        kind: options.launch ? "agent" : "shell",
        cwd: options.cwd,
        rows: createdRows,
        cols: createdCols,
        // A launch intent carries the run-identity env vars, so it supersedes the runspace
        // env rather than being merged with it. The agent scaffolding and the tab/session
        // ids are injected backend-side.
        env: options.launch?.env ?? options.env,
      });
      // The tab may have been closed while the create was pending; the closer found no
      // sessionId to end. Nothing has run in the session yet, so there is nothing worth
      // keeping detached — kill it rather than leave an orphan the UI can no longer reach.
      if (getTabConnection(tabId) !== conn) {
        terminalTerminate(session.id).catch((e: unknown) => {
          console.warn(`terminal terminate failed for orphaned session ${session.id}:`, e);
        });
        return;
      }
      sessionId = session.id;
      options.onSessionCreated?.(session.id);
      if (session.status === "failed") {
        store.set(setSessionStatusAtom, session.id, { status: "failed" });
        conn.state = "dead";
        return;
      }
    }
    conn.sessionId = sessionId;
    sessionIdRef.current = sessionId;

    let live = false;
    const pending: string[] = [];
    conn.unlisteners.push(
      await onTerminalOutput(sessionId, (data) => {
        if (live) getTabTerminal(tabId)?.write(fromBase64(data));
        else pending.push(data);
      }),
    );
    const sid = sessionId;
    conn.unlisteners.push(
      await onTerminalExit(sid, (code) => {
        store.set(setSessionStatusAtom, sid, { status: "exited", exitCode: code });
        releaseTabConnection(tabId);
        optionsRef.current.onExit?.();
      }),
    );

    // Released while subscribing: the closer already ended the session by id; attaching
    // now would pull it back out of the Detached group with no tab to own it.
    if (getTabConnection(tabId) !== conn) {
      dropListeners(conn);
      return;
    }

    const attach = await terminalAttach(sessionId);
    // Released mid-attach: the closer's detach may have landed before this attach, so
    // detach again to leave the session where the closer put it.
    if (getTabConnection(tabId) !== conn) {
      dropListeners(conn);
      terminalDetach(sid).catch((e: unknown) => {
        console.warn(`terminal detach failed for released session ${sid}:`, e);
      });
      return;
    }
    // No reset before the replay: the terminal here is always a freshly mounted (empty)
    // instance — the connection guard prevents double-attach — and Terminal.reset()
    // corrupts the WebGL renderer (blank canvas, "this._renderer.value.dimensions"
    // TypeErrors) once WebglAddon is loaded.
    const term = getTabTerminal(tabId);
    if (term) {
      if (attach.replay) {
        // Queries recorded in the replay were already answered (or abandoned) when they
        // were live; answering them again would inject the responses into the shell's
        // stdin as command-line input. The write callback fires after the replay chunk
        // is parsed and before the pending (live) writes below, which keep responding.
        conn.replaying = true;
        term.write(fromBase64(attach.replay), () => {
          conn.replaying = false;
        });
      }
      live = true;
      for (const data of pending) term.write(fromBase64(data));
      pending.length = 0;
    } else {
      live = true;
    }
    conn.state = "attached";
    store.set(setSessionStatusAtom, sessionId, { status: "running" });

    // The pane may have been opened and fitted while the create/attach was in flight.
    if (isNew && term?.element && (term.rows !== createdRows || term.cols !== createdCols)) {
      terminalResize(sid, term.rows, term.cols);
    }

    const initialCommand = isNew ? optionsRef.current.launch?.initialCommand : undefined;
    if (initialCommand) {
      setTimeout(() => {
        terminalWrite(sid, toBase64(encoder.encode(initialCommand + "\r")));
        optionsRef.current.onLaunchConsumed?.();
      }, 500);
    }
  } catch (e) {
    console.warn(`terminal connect failed for tab ${tabId}:`, e);
    conn.state = "dead";
    dropListeners(conn);
    // No pretend-reconnect: a session we cannot attach to is honestly lost.
    if (sessionId) {
      store.set(setSessionStatusAtom, sessionId, { status: "lost" });
    }
  } finally {
    conn.inFlight = undefined;
  }
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions,
) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(options.sessionId ?? null);
  sessionIdRef.current = options.sessionId ?? sessionIdRef.current;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const store = getDefaultStore();
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', monospace",
      fontSize: store.get(terminalFontSizeAtom),
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: false,
      allowProposedApi: true,
      scrollback: 5000,
      // ghostty の default_word_boundaries に揃えた語境界集合。
      wordSeparator: " \t'\"│`|:;,()[]{}<>$",
      // マウスレポート中の TUI でも修飾キーでローカル選択を許可する (mac は Option)。
      macOptionClickForcesSelection: true,
      // OSC 8 ハイパーリンクも regex リンクと同様 cmd 押下時のみ発火させる (ghostty 準拠)。
      linkHandler: {
        activate: (event, uri) => {
          if (event.metaKey) openUrl(uri);
        },
      },
      theme: TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());

    termRef.current = term;
    fitRef.current = fitAddon;
    setTabTerminal(options.tabId, term);

    const cleanup = new EventCleanupManager();

    const sendBytes = (bytes: Uint8Array) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || getTabConnection(options.tabId)?.replaying) return;
      terminalWrite(sessionId, toBase64(bytes));
    };
    const writeText = (text: string) => sendBytes(encoder.encode(text));

    term.onData(writeText);

    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i);
      }
      sendBytes(bytes);
    });

    term.onTitleChange((title) => {
      optionsRef.current.onTitleChange?.(title);
    });

    registerParsers(term, writeText, () => optionsRef.current.onCwdChange);

    term.attachCustomKeyEventHandler(
      buildKeyEventHandler(
        () => store.get(jumpHintsActiveAtom),
        writeText,
        (delta: 1 | -1) => store.set(zoomTerminalAtom, delta),
      ),
    );

    function blockPhantom(e: Event) {
      if (e instanceof MouseEvent && e.buttons === 0) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    const onWheel = createWheelHandler(term, writeText);

    const container = containerRef.current;
    if (container) {
      cleanup.addEventListener(container, "mousedown", blockPhantom, true);
      cleanup.addEventListener(container, "pointerdown", blockPhantom, true);
      cleanup.addEventListener(container, "wheel", onWheel, { capture: true });
      cleanup.add(attachTapSelection(term, container));
      cleanup.add(attachTerminalLinks(term, container, () => optionsRef.current.cwd));
    }

    const unsubFontSize = store.sub(terminalFontSizeAtom, () => {
      const size = store.get(terminalFontSizeAtom);
      term.options.fontSize = size;
      if (openedRef.current && fitRef.current) {
        fitAndResize(fitRef.current, term, sessionIdRef);
      }
    });
    cleanup.add(unsubFontSize);

    return () => {
      // The tab connection (session listeners) deliberately survives unmount/remount;
      // it is released by the store when the tab closes or starts a new shell. The
      // terminal registry entry must go first so in-flight writes stop resolving to a
      // disposed instance.
      clearTabTerminal(options.tabId, term);
      // dispose() drops xterm's write queue, so a replay write callback may never fire;
      // unstick the mute or the remounted terminal would silently drop all input.
      const conn = getTabConnection(options.tabId);
      if (conn) conn.replaying = false;
      // Release before disposeAll: the pool must not keep a GL context alive because
      // an unrelated listener cleanup threw.
      webglRendererPool.release(term);
      cleanup.disposeAll();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [options.tabId, containerRef]);

  // A tab without a session starts one as soon as it exists, shown or not: a run launched
  // from the board must have its shell and agent going before the user looks at it. xterm
  // buffers writes to an unopened terminal, so the output is already there on activation.
  // Existing sessions are only re-attached when shown — their replay is sized to the pane.
  useEffect(() => {
    if (options.sessionId || isDeadStatus(options.sessionStatus)) return;
    const conn = getTabConnection(options.tabId);
    if (conn?.inFlight || conn?.state === "attached") return;
    connectTab(optionsRef, sessionIdRef);
  }, [options.tabId, options.sessionId, options.sessionStatus]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container || !options.active) return;

    if (!openedRef.current) {
      term.open(container);
      openedRef.current = true;
    }

    fit.fit();

    // A dead session never reconnects; the pane overlay offers a fresh shell instead.
    const conn = getTabConnection(options.tabId);
    if (!conn?.inFlight && conn?.state !== "attached" && !isDeadStatus(options.sessionStatus)) {
      connectTab(optionsRef, sessionIdRef);
    }

    if (sessionIdRef.current && conn?.state === "attached") {
      terminalResize(sessionIdRef.current, term.rows, term.cols);
    }
    term.focus();

    const observer = new ResizeObserver(() => {
      if (fitDebounce) clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => {
        fitAndResize(fit, term, sessionIdRef);
      }, 100);
    });

    let fitDebounce: number | undefined;
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (fitDebounce) clearTimeout(fitDebounce);
    };
  }, [
    options.active,
    options.tabId,
    options.sessionId,
    options.sessionStatus,
    options.cwd,
    containerRef,
  ]);

  // Activation only acquires; the pane keeps its WebGL renderer after deactivation
  // until the pool LRU-evicts it, so hopping between recent tabs skips the expensive
  // renderer swap. Deps deliberately exclude session/cwd so those changes don't churn
  // the addon. The open effect above runs first in the same commit, so the terminal is
  // always opened here.
  useEffect(() => {
    if (!options.active) return;
    const term = termRef.current;
    if (!term || !openedRef.current) return;
    webglRendererPool.acquire(term);
  }, [options.active, options.tabId, containerRef]);

  useEffect(() => {
    if (!options.active) return;
    const store = getDefaultStore();
    const unsubs = [
      store.sub(terminalFocusRequestAtom, () => {
        termRef.current?.focus();
      }),
      store.sub(activeSpaceAtom, () => {
        if (store.get(activeSpaceAtom) === "work-bench") {
          requestAnimationFrame(() => termRef.current?.focus());
        }
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [options.active, options.tabId]);

  return termRef;
}
