import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { getDefaultStore } from "jotai";
import { ptySpawn, ptyWrite, ptyResize, onPtyOutput, onPtyExit } from "@/commands/pty";
import { prefixActiveAtom } from "@/stores/space";
import { terminalFontSizeAtom, zoomTerminalAtom } from "@/stores/terminal";

const aliveSessions = new Set<string>();

export function markSessionDead(tabId: string) {
  aliveSessions.delete(tabId);
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

type UseTerminalOptions = {
  tabId: string;
  cwd: string;
  active: boolean;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
  onExit?: () => void;
};

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions,
) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const store = getDefaultStore();
    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', monospace",
      fontSize: store.get(terminalFontSizeAtom),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: "#222436",
        foreground: "#fdfff1",
        cursor: "#c0c1b5",
        cursorAccent: "#8d8e82",
        selectionBackground: "#57584f",
        selectionForeground: "#fdfff1",
        black: "#272822",
        red: "#f92672",
        green: "#a6e22e",
        yellow: "#f4bf75",
        blue: "#66d9ef",
        magenta: "#ae81ff",
        cyan: "#a1efe4",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#f92672",
        brightGreen: "#a6e22e",
        brightYellow: "#f4bf75",
        brightBlue: "#66d9ef",
        brightMagenta: "#ae81ff",
        brightCyan: "#a1efe4",
        brightWhite: "#f9f8f5",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());

    termRef.current = term;
    fitRef.current = fitAddon;

    const encoder = new TextEncoder();
    const cleanups: (() => void)[] = [];

    term.onData((data) => {
      ptyWrite(options.tabId, toBase64(encoder.encode(data)));
    });

    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i);
      }
      ptyWrite(options.tabId, toBase64(bytes));
    });

    term.onTitleChange((title) => {
      optionsRef.current.onTitleChange?.(title);
    });

    // Kitty keyboard protocol: respond to query (CSI ? u) and absorb push/pop
    term.parser.registerCsiHandler({ final: "u", prefix: "?" }, () => {
      ptyWrite(options.tabId, toBase64(encoder.encode("\x1b[?1u")));
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
          ptyWrite(options.tabId, toBase64(encoder.encode("\x1b[13;2u")));
        }
        return false;
      }
      if (store.get(prefixActiveAtom)) return false;
      if (e.altKey) return false;
      if (e.ctrlKey && e.key === "t") return false;
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
    const container = containerRef.current;
    if (container) {
      container.addEventListener("mousedown", blockPhantom, true);
      container.addEventListener("pointerdown", blockPhantom, true);
      cleanups.push(() => {
        container.removeEventListener("mousedown", blockPhantom, true);
        container.removeEventListener("pointerdown", blockPhantom, true);
      });
    }

    onPtyOutput(options.tabId, (data) => {
      term.write(fromBase64(data));
    }).then((unlisten) => cleanups.push(unlisten));

    onPtyExit(options.tabId, () => {
      aliveSessions.delete(options.tabId);
      optionsRef.current.onExit?.();
    }).then((unlisten) => cleanups.push(unlisten));

    const unsubFontSize = store.sub(terminalFontSizeAtom, () => {
      const size = store.get(terminalFontSizeAtom);
      term.options.fontSize = size;
      if (openedRef.current && fitRef.current) {
        fitRef.current.fit();
        ptyResize(options.tabId, term.rows, term.cols);
      }
    });
    cleanups.push(unsubFontSize);

    return () => {
      for (const fn of cleanups) fn();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [options.tabId]);

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

    if (!aliveSessions.has(options.tabId)) {
      aliveSessions.add(options.tabId);
      ptySpawn(options.tabId, options.cwd, term.rows, term.cols).catch(() => {
        aliveSessions.delete(options.tabId);
        term.writeln("\r\n\x1b[31mFailed to spawn shell. Press any key to retry.\x1b[0m");
      });
    }

    ptyResize(options.tabId, term.rows, term.cols);
    term.focus();

    const observer = new ResizeObserver(() => {
      if (fitDebounce) clearTimeout(fitDebounce);
      fitDebounce = window.setTimeout(() => {
        fit.fit();
        ptyResize(options.tabId, term.rows, term.cols);
      }, 100);
    });

    let fitDebounce: number | undefined;
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (fitDebounce) clearTimeout(fitDebounce);
    };
  }, [options.active, options.tabId, options.cwd, containerRef]);

  return termRef;
}
