import type { Terminal } from '@xterm/xterm'

type Cell = { chars: string; col: number; row: number; width: number }
type Range = { col: number; row: number; length: number }

// WKWebView は tap-to-click に mousedown を発行せず buttons=0 の pointerdown だけを送る。
// xterm の選択は mousedown 駆動なのでタップでは選択が始まらない。この層が pointer
// イベントから ghostty 流の選択（シングル=クリア / ダブル=語 / トリプル=行）を再現する。
// 物理押し込み (buttons=1) は mousedown が出るので xterm ネイティブに委ねる。
// WKWebView は pointerdown/pointerup の対応が 1 個ずれて届く（先頭に孤立 up が出る）ため
// down→up を対にする方式は 1 タップずれる。pointerdown だけで完結させ、1 タップが生む複数の
// pointerdown と detail の不安定さは時間ベースの自前カウント＋至近 DEDUP で吸収する。
const TAP_REPEAT_MS = 500
const TAP_REPEAT_DIST_PX = 24
const TAP_DEDUP_MS = 80

function logicalLineCells(term: Terminal, row: number): Cell[] {
  const buffer = term.buffer.active
  let start = row
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--

  const cells: Cell[] = []
  for (let r = start; ; r++) {
    const line = buffer.getLine(r)
    if (!line) break
    for (let c = 0; c < line.length; c++) {
      const cell = line.getCell(c)
      if (!cell) continue
      const width = cell.getWidth()
      if (width === 0) continue
      cells.push({ chars: cell.getChars(), col: c, row: r, width })
    }
    if (!buffer.getLine(r + 1)?.isWrapped) break
  }
  return cells
}

function coordsFromEvent(term: Terminal, screen: HTMLElement, e: PointerEvent) {
  const rect = screen.getBoundingClientRect()
  if (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  ) {
    return null
  }
  const col = Math.min(
    term.cols - 1,
    Math.floor(((e.clientX - rect.left) / rect.width) * term.cols),
  )
  const viewportRow = Math.min(
    term.rows - 1,
    Math.floor(((e.clientY - rect.top) / rect.height) * term.rows),
  )
  return { col, row: term.buffer.active.viewportY + viewportRow }
}

function rangeOf(cells: Cell[]): Range | null {
  const [first] = cells
  if (!first) return null
  const length = cells.reduce((sum, c) => sum + c.width, 0)
  return { col: first.col, row: first.row, length }
}

function selectWord(term: Terminal, cells: Cell[], col: number, row: number): Range | null {
  const idx = cells.findIndex((c) => c.row === row && c.col <= col && col < c.col + c.width)
  const hit = cells[idx]
  if (!hit || hit.chars === '') return null

  const separators = term.options.wordSeparator ?? ''
  const isSep = (c: Cell) => c.chars !== '' && separators.includes(c.chars)
  const expectSep = isSep(hit)
  const extendsRun = (c: Cell | undefined) =>
    c !== undefined && c.chars !== '' && isSep(c) === expectSep

  let from = idx
  let to = idx
  while (extendsRun(cells[from - 1])) from--
  while (extendsRun(cells[to + 1])) to++
  return rangeOf(cells.slice(from, to + 1))
}

function selectLine(cells: Cell[]): Range | null {
  const isWhitespace = (c: Cell) => c.chars === '' || c.chars === ' ' || c.chars === '\t'

  const from = cells.findIndex((c) => !isWhitespace(c))
  if (from < 0) return rangeOf(cells)
  const to = cells.findLastIndex((c) => !isWhitespace(c))
  return rangeOf(cells.slice(from, to + 1))
}

export function attachTapSelection(term: Terminal, container: HTMLElement): () => void {
  let lastTapTime = 0
  let lastTapX = 0
  let lastTapY = 0
  let tapCount = 0
  // .xterm-screen は term.open() で一度だけ生成され reset() もしないので、初回ヒットを使い回す。
  let screen: HTMLElement | null = null

  const onPointerDown = (e: PointerEvent) => {
    // 物理押し込みは buttons=1 で mousedown も出るため xterm ネイティブに任せる。
    if (e.buttons !== 0 || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return
    // マウスレポート中の TUI では Option 押下時のみローカル選択する (ghostty 準拠)。
    if (term.modes.mouseTrackingMode !== 'none' && !e.altKey) return

    screen ??= container.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return
    const coords = coordsFromEvent(term, screen, e)
    if (!coords) return

    const now = performance.now()
    const sinceLast = now - lastTapTime
    // 1 タップが生む至近の重複 pointerdown は無視する。
    if (sinceLast < TAP_DEDUP_MS) return

    const isRepeat =
      sinceLast <= TAP_REPEAT_MS &&
      Math.abs(e.clientX - lastTapX) <= TAP_REPEAT_DIST_PX &&
      Math.abs(e.clientY - lastTapY) <= TAP_REPEAT_DIST_PX
    tapCount = isRepeat ? Math.min(tapCount + 1, 3) : 1
    lastTapTime = now
    lastTapX = e.clientX
    lastTapY = e.clientY

    if (tapCount === 1) {
      term.clearSelection()
      return
    }

    const cells = logicalLineCells(term, coords.row)
    const range =
      tapCount === 2 ? selectWord(term, cells, coords.col, coords.row) : selectLine(cells)
    if (range) term.select(range.col, range.row, range.length)
    else term.clearSelection()
  }

  container.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    container.removeEventListener('pointerdown', onPointerDown, true)
  }
}
