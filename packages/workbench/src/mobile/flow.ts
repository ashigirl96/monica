import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

const ansi = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec',
]
const cube = [0, 95, 135, 175, 215, 255]
const foreground = '#ffffff'
const background = '#000000'

function palette(index: number): string {
  if (index < 16) return ansi[index] ?? foreground
  if (index < 232) {
    const value = index - 16
    return `rgb(${cube[Math.floor(value / 36)]},${cube[Math.floor(value / 6) % 6]},${cube[value % 6]})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray},${gray},${gray})`
}

function rgb(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function cellStyle(cell: IBufferCell): string {
  let fg = cell.isFgRGB()
    ? rgb(cell.getFgColor())
    : cell.isFgPalette()
      ? palette(cell.getFgColor())
      : null
  let bg = cell.isBgRGB()
    ? rgb(cell.getBgColor())
    : cell.isBgPalette()
      ? palette(cell.getBgColor())
      : null
  if (cell.isInverse()) [fg, bg] = [bg ?? background, fg ?? foreground]
  if (cell.isInvisible()) fg = bg ?? background
  return [
    fg && `color:${fg}`,
    bg && `background:${bg}`,
    cell.isBold() && 'font-weight:700',
    cell.isDim() && 'opacity:.6',
    cell.isItalic() && 'font-style:italic',
    cell.isUnderline() && 'text-decoration:underline',
  ]
    .filter(Boolean)
    .join(';')
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function isBlank(cell: IBufferCell): boolean {
  const chars = cell.getChars()
  return (chars === '' || chars === ' ') && cell.isBgDefault() && !cell.isInverse()
}

function rowHtml(
  line: IBufferLine,
  cell: IBufferCell,
  trim: boolean,
  cursor: number | null,
): string {
  let end = line.length
  if (trim) while (end > 0 && isBlank(line.getCell(end - 1, cell)!)) end--
  if (cursor !== null) end = Math.max(end, cursor + 1)
  let html = ''
  let run = ''
  let style = ''
  const flush = () => {
    if (run) html += style ? `<span style="${style}">${escape(run)}</span>` : escape(run)
    run = ''
  }
  for (let x = 0; x < end; x++) {
    const current = line.getCell(x, cell)
    if (current?.getWidth() === 0) continue
    const chars = current?.getChars() || ' '
    const next = current ? cellStyle(current) : ''
    if (x === cursor) {
      flush()
      html += `<span class="flow-cursor">${escape(chars)}</span>`
      continue
    }
    if (next !== style) {
      flush()
      style = next
    }
    run += chars
  }
  flush()
  return html
}

const rowCache = new Map<string, string>()

/** Joins the rows xterm soft-wrapped at the Mac width so CSS can wrap them at the phone width. */
export function renderFlow(buffer: IBuffer, limit = 600): string {
  const cell = buffer.getNullCell()
  const cursorRow = buffer.baseY + buffer.cursorY
  let last = buffer.length - 1
  while (last > cursorRow && !buffer.getLine(last)?.translateToString(true)) last--
  let first = Math.max(0, last - limit)
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  if (rowCache.size > 4000) rowCache.clear()
  const lines: string[] = []
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    const trim = !(row < last && buffer.getLine(row + 1)?.isWrapped)
    const cursor = row === cursorRow ? buffer.cursorX : null
    // Scrollback rows no longer change, so their markup is reused across renders.
    const key = row < buffer.baseY ? `${trim ? 1 : 0}${line.translateToString(false)}` : null
    let html = key === null ? undefined : rowCache.get(key)
    if (html === undefined) {
      html = rowHtml(line, cell, trim, cursor)
      if (key !== null) rowCache.set(key, html)
    }
    if (line.isWrapped && lines.length) lines[lines.length - 1] += html
    else lines.push(html)
  }
  return lines.map((html) => `<div>${html}</div>`).join('')
}
