import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { attachTapSelection } from "@/features/work-bench/ui/tap-selection";
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

const PIXELS_PER_LINE = 20;

function buildSgrWheelSequence(lines: number, down: boolean, col: number, row: number): string {
  const code = down ? 65 : 64;
  const event = `\x1b[<${code};${col};${row}M`;
  return event.repeat(lines);
}

function toBase64(input: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < input.length; i++) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();

function isDeadStatus(status: TerminalSessionStatus | undefined): boolean {
  return status === "exited" || status === "lost" || status === "failed";
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
      linkHandler: {
        activate: (_event, uri) => {
          openUrl(uri);
        },
      },
      theme: {
        background: "#1d1f21",
        foreground: "#c5c8c6",
        cursor: "#c5c8c6",
        cursorAccent: "#1d1f21",
        selectionBackground: "#c5c8c6",
        selectionForeground: "#1d1f21",
        black: "#1d1f21",
        red: "#cc6666",
        green: "#b5bd68",
        yellow: "#f0c674",
        blue: "#81a2be",
        magenta: "#b294bb",
        cyan: "#8abeb7",
        white: "#c5c8c6",
        brightBlack: "#666666",
        brightRed: "#d54e53",
        brightGreen: "#b9ca4a",
        brightYellow: "#e7c547",
        brightBlue: "#7aa6da",
        brightMagenta: "#c397d8",
        brightCyan: "#70c0b1",
        brightWhite: "#eaeaea",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri);
      }),
    );

    termRef.current = term;
    fitRef.current = fitAddon;
    setTabTerminal(options.tabId, term);

    const cleanups: (() => void)[] = [];

    const writeText = (text: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || getTabConnection(options.tabId)?.replaying) return;
      terminalWrite(sessionId, toBase64(encoder.encode(text)));
    };

    term.onData(writeText);

    term.onBinary((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || getTabConnection(options.tabId)?.replaying) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i);
      }
      terminalWrite(sessionId, toBase64(bytes));
    });

    term.onTitleChange((title) => {
      optionsRef.current.onTitleChange?.(title);
    });

    // Kitty keyboard protocol: respond to query (CSI ? u) and absorb push/pop
    term.parser.registerCsiHandler({ final: "u", prefix: "?" }, () => {
      writeText("\x1b[?1u");
      return true;
    });
    term.parser.registerCsiHandler({ final: "u", prefix: ">" }, () => true);
    term.parser.registerCsiHandler({ final: "u", prefix: "<" }, () => true);

    term.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        if (url.protocol !== "file:") return false;
        const cwd = decodeURIComponent(url.pathname);
        optionsRef.current.onCwdChange?.(cwd);
        return true;
      } catch {
        return false;
      }
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Enter") {
        if (e.type === "keydown") {
          writeText("\x1b[13;2u");
        }
        return false;
      }
      if (store.get(jumpHintsActiveAtom)) return false;
      if (e.altKey) return false;
      if (e.ctrlKey && e.key === "t") return false;
      if (e.ctrlKey && e.key === "Tab") return false;
      if (e.metaKey && /^[0-4]$/.test(e.key)) return false;
      if (e.metaKey && e.type === "keydown") {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          store.set(zoomTerminalAtom, 1);
          return false;
        }
        if (e.key === "-") {
          e.preventDefault();
          store.set(zoomTerminalAtom, -1);
          return false;
        }
      }
      return true;
    });

    function blockPhantom(e: Event) {
      if (e instanceof MouseEvent && e.buttons === 0) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    let scrollAccumulator = 0;

    function onWheel(e: WheelEvent) {
      if (term.buffer.active.type !== "alternate") return;

      e.preventDefault();
      e.stopPropagation();

      const delta =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * PIXELS_PER_LINE : e.deltaY;

      scrollAccumulator += delta;

      const lines = Math.trunc(scrollAccumulator / PIXELS_PER_LINE);
      if (lines === 0) return;

      scrollAccumulator -= lines * PIXELS_PER_LINE;

      const absLines = Math.min(Math.abs(lines), term.rows);
      const down = lines > 0;
      const col = Math.floor(term.cols / 2);
      const row = Math.floor(term.rows / 2);
      const seq = buildSgrWheelSequence(absLines, down, col, row);
      writeText(seq);
    }

    const container = containerRef.current;
    if (container) {
      container.addEventListener("mousedown", blockPhantom, true);
      container.addEventListener("pointerdown", blockPhantom, true);
      container.addEventListener("wheel", onWheel, { capture: true });
      cleanups.push(attachTapSelection(term, container));
      cleanups.push(() => {
        container.removeEventListener("mousedown", blockPhantom, true);
        container.removeEventListener("pointerdown", blockPhantom, true);
        container.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      });
    }

    const unsubFontSize = store.sub(terminalFontSizeAtom, () => {
      const size = store.get(terminalFontSizeAtom);
      term.options.fontSize = size;
      if (openedRef.current && fitRef.current) {
        fitRef.current.fit();
        if (sessionIdRef.current) {
          terminalResize(sessionIdRef.current, term.rows, term.cols);
        }
      }
    });
    cleanups.push(unsubFontSize);

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
      for (const fn of cleanups) fn();
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

      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // canvas renderer fallback
      }

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
        fit.fit();
        if (sessionIdRef.current) {
          terminalResize(sessionIdRef.current, term.rows, term.cols);
        }
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
