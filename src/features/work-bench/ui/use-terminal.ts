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
  terminalResize,
  terminalWrite,
  type TerminalSessionStatus,
} from "@/commands/terminal";
import { activeSpaceAtom } from "@/stores/space";
import {
  jumpHintsActiveAtom,
  setSessionStatusAtom,
  terminalFontSizeAtom,
  terminalFocusRequestAtom,
  zoomTerminalAtom,
  type TerminalLaunchIntent,
} from "@/features/work-bench/store";
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
  fit.fit();
  if (sessionIdRef.current) {
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
    if (!sessionId) {
      const options = optionsRef.current;
      const term = getTabTerminal(tabId);
      const session = await terminalCreateSession({
        runspaceId: options.runspaceId,
        tabId,
        kind: options.launch ? "agent" : "shell",
        cwd: options.cwd,
        rows: term?.rows ?? 24,
        cols: term?.cols ?? 80,
        // A launch intent carries the complete shell env (runspace env + run ids), so it
        // supersedes the runspace env rather than being merged with it. The tab and
        // session ids are injected backend-side.
        env: options.launch?.env ?? options.env,
      });
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

    const attach = await terminalAttach(sessionId);
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
    for (const unlisten of conn.unlisteners) unlisten();
    conn.unlisteners = [];
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
      cleanup.disposeAll();
      webglRendererPool.release(term);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [options.tabId, containerRef]);

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
