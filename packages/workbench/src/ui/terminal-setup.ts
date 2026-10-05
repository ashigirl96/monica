import type { IDisposable, ITheme, Terminal } from '@xterm/xterm'

const PIXELS_PER_LINE = 20
const DOM_DELTA_LINE = 1

function buildSgrWheelSequence(lines: number, down: boolean, col: number, row: number): string {
  const code = down ? 65 : 64
  const event = `\x1b[<${code};${col};${row}M`
  return event.repeat(lines)
}

export const TERMINAL_THEME: ITheme = {
  background: '#1d1f21',
  foreground: '#c5c8c6',
  cursor: '#c5c8c6',
  cursorAccent: '#1d1f21',
  selectionBackground: '#c5c8c6',
  selectionForeground: '#1d1f21',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
} as const

export function registerParsers(
  term: Terminal,
  getCwdChangeHandler: () => ((cwd: string) => void) | undefined,
): void {
  term.parser.registerOscHandler(7, (data: string) => {
    try {
      const url = new URL(data)
      if (url.protocol !== 'file:') return false
      const cwd = decodeURIComponent(url.pathname)
      getCwdChangeHandler()?.(cwd)
      return true
    } catch {
      return false
    }
  })
}

type CoreWithUserInput = {
  _core?: { coreService?: { onUserInput?: (listener: () => void) => IDisposable } }
}

// xterm は利用者の入力（キー・IME・paste・マウス）の onData の直前にだけ内部の onUserInput を出すので、それで自分の応答と見分ける。
export function onTerminalData(
  term: Terminal,
  handlers: { input: (data: string) => void; reply: (data: string) => void },
): void {
  let fromUser = false
  ;(term as unknown as CoreWithUserInput)._core?.coreService?.onUserInput?.(() => {
    fromUser = true
  })
  term.onData((data) => {
    if (fromUser) handlers.input(data)
    else handlers.reply(data)
    fromUser = false
  })
}

export function buildKeyEventHandler(
  isJumpHintsActive: () => boolean,
  onZoom: (delta: 1 | -1) => void,
  onSelectAll: () => void,
): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent) => {
    if (isJumpHintsActive()) return false
    if (e.altKey) return false
    if (e.ctrlKey && e.key === 't') return false
    if (e.ctrlKey && e.key === 'Tab') return false
    if (e.metaKey && e.type === 'keydown') {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        onZoom(1)
        return false
      }
      if (e.key === '-') {
        e.preventDefault()
        onZoom(-1)
        return false
      }
      if (e.key === 'a') {
        onSelectAll()
        return false
      }
    }
    // kitty の flag を立てた app には、xterm が ⌘ を super として送り、イベントを cancel して copy と paste を止める。
    if (e.metaKey && e.key.length === 1) return false
    return true
  }
}

const SGR_MOUSE_MODE = 1006
/// xterm holds one active mouse encoding, so `?1016h` (pixel coordinates) displaces `?1006h`
/// and resetting either clears the slot. These live here rather than coming from the daemon
/// because they are read straight out of xterm's parser callback -- routing a fact xterm
/// already handed us back through the PTY protocol would only add a way for the two to drift.
const MOUSE_ENCODING_MODES = [SGR_MOUSE_MODE, 1016]

/// `IModes` exposes which mouse events an app wants but not how it wants them encoded, so the
/// encoding has to be watched here. Returning false leaves xterm's own DEC mode handling
/// intact -- the handler only observes.
function trackSgrMouseMode(term: Terminal): () => boolean {
  let active = 0
  const observe = (on: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      if (typeof param === 'number' && MOUSE_ENCODING_MODES.includes(param)) {
        active = on ? param : 0
      }
    }
    return false
  }
  term.parser.registerCsiHandler({ final: 'h', prefix: '?' }, observe(true))
  term.parser.registerCsiHandler({ final: 'l', prefix: '?' }, observe(false))
  return () => active === SGR_MOUSE_MODE
}

export function createWheelHandler(
  term: Terminal,
  writeText: (text: string) => void,
): (e: WheelEvent) => void {
  const sgrMouseEnabled = trackSgrMouseMode(term)
  let scrollAccumulator = 0

  return (e: WheelEvent) => {
    // Keyed on mouse reporting, not the alt screen: a pane reconnected from a replay tail
    // that predates the app's one-shot `?1049h` still reads as the normal buffer, and
    // falling back to xterm's wheel path there caps it at one SGR event per DOM event.
    // Without `?1006` the app cannot read these reports, so xterm's encoder has to own it.
    if (term.modes.mouseTrackingMode === 'none' || !sgrMouseEnabled()) return

    e.preventDefault()
    e.stopPropagation()

    const delta = e.deltaMode === DOM_DELTA_LINE ? e.deltaY * PIXELS_PER_LINE : e.deltaY

    scrollAccumulator += delta

    const lines = Math.trunc(scrollAccumulator / PIXELS_PER_LINE)
    if (lines === 0) return

    scrollAccumulator -= lines * PIXELS_PER_LINE

    const absLines = Math.min(Math.abs(lines), term.rows)
    const down = lines > 0
    const col = Math.floor(term.cols / 2)
    const row = Math.floor(term.rows / 2)
    const seq = buildSgrWheelSequence(absLines, down, col, row)
    writeText(seq)
  }
}
