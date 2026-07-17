import type { Terminal, ITheme } from "@xterm/xterm";

const PIXELS_PER_LINE = 20;

function buildSgrWheelSequence(lines: number, down: boolean, col: number, row: number): string {
  const code = down ? 65 : 64;
  const event = `\x1b[<${code};${col};${row}M`;
  return event.repeat(lines);
}

export const TERMINAL_THEME: ITheme = {
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
} as const;

export function registerParsers(
  term: Terminal,
  writeText: (text: string) => void,
  getCwdChangeHandler: () => ((cwd: string) => void) | undefined,
): void {
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
      getCwdChangeHandler()?.(cwd);
      return true;
    } catch {
      return false;
    }
  });
}

export function buildKeyEventHandler(
  isJumpHintsActive: () => boolean,
  writeText: (text: string) => void,
  onZoom: (delta: 1 | -1) => void,
): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent) => {
    if (e.shiftKey && e.key === "Enter") {
      if (e.type === "keydown") {
        writeText("\x1b[13;2u");
      }
      return false;
    }
    if (isJumpHintsActive()) return false;
    if (e.altKey) return false;
    if (e.ctrlKey && e.key === "t") return false;
    if (e.ctrlKey && e.key === "Tab") return false;
    if (e.metaKey && /^[0-4]$/.test(e.key)) return false;
    if (e.metaKey && e.type === "keydown") {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        onZoom(1);
        return false;
      }
      if (e.key === "-") {
        e.preventDefault();
        onZoom(-1);
        return false;
      }
    }
    return true;
  };
}

export function createWheelHandler(
  term: Terminal,
  writeText: (text: string) => void,
): (e: WheelEvent) => void {
  let scrollAccumulator = 0;

  return (e: WheelEvent) => {
    if (term.buffer.active.type !== "alternate") return;

    e.preventDefault();
    e.stopPropagation();

    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * PIXELS_PER_LINE : e.deltaY;

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
  };
}
