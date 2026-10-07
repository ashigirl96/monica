import { isDelimiterLine, opensBlockAt } from './from-markdown.ts'
import { isAlphanumeric, isAsciiPunctuation, isSpace } from './text.ts'

/** 書き出す文字列の断片。mark の記号・href・code の中身のように構文として書いた文字は `plain` でなく、escape しない。 */
export type Piece = { text: string; plain: boolean }

/**
 * fromMarkdown が行頭をどう読むか。
 * - `block`: どの行の行頭も block の構文として読む。
 * - `afterMarker`: 1 行目は見出しか list の印（`marker`）の後ろにあり、hardBreak の後の行だけを block の構文として読む。
 * - `inline`: どの行も inline として読む。
 * - `cell`: 表のセルで、inline として読み、hardBreak は空白にする。
 */
export type LineStart =
  | { kind: 'block' }
  | { kind: 'afterMarker'; marker: string }
  | { kind: 'inline' }
  | { kind: 'cell' }

type Glyph = { char: string; plain: boolean; escaped: boolean }

const EMPHASIS = ['*', '~', '_']

/** 素の文字のうち、fromMarkdown がその位置で構文として読むものだけを backslash で escape してつなぐ。 */
export function writeEscaped(pieces: Piece[], lineStart: LineStart): string {
  const glyphs = pieces.flatMap((piece) =>
    Array.from(piece.text, (char) => ({ char, plain: piece.plain, escaped: false })),
  )
  if (lineStart.kind === 'cell') return writeCell(glyphs)
  const lines = splitLines(glyphs)
  for (const line of lines) escapeInline(line)
  if (lineStart.kind !== 'inline') escapeLineStarts(lines, lineStart)
  return lines.map(lineText).join('\n')
}

// セルは表の 1 行の中に書くので、hardBreak を空白にしてから決める。
function writeCell(glyphs: Glyph[]): string {
  const line = glyphs.map((glyph) => (glyph.char === '\n' ? { ...glyph, char: ' ' } : glyph))
  escapeInline(line)
  // `|` は code や href の中でもセルを区切るので escape し、直前に続く `\` も重ねて `\|` の escape を食わせない。
  let beforePipe = false
  for (const glyph of line.toReversed()) {
    if (glyph.char === '|') beforePipe = true
    else if (glyph.char !== '\\') beforePipe = false
    if (beforePipe) glyph.escaped = true
  }
  return lineText(line)
}

function escapeInline(line: Glyph[]): void {
  // 強調は同じ行の中の同じ記号と対になるので、行に 1 つしか無い記号は開きも閉じもしない（`~/.claude`・`2*3`）。
  const paired = new Set(
    EMPHASIS.filter((char) => line.filter((glyph) => glyph.char === char).length > 1),
  )
  line.forEach((glyph, index) => {
    if (glyph.plain && isInlineSyntax(line, index, paired)) glyph.escaped = true
  })
}

function isInlineSyntax(line: Glyph[], index: number, paired: Set<string>): boolean {
  const char = line[index]?.char ?? ''
  const before = line[index - 1]?.char
  const after = line[index + 1]?.char
  switch (char) {
    case '\\':
      return isAsciiPunctuation(after ?? '')
    case '`':
    case '[':
    case ']':
      return true
    case '<':
      return followedBy(line, index, 'u>') || followedBy(line, index, '/u>')
    case '*':
    case '~':
      return paired.has(char) && !standsAlone(before, after)
    case '_':
      return paired.has(char) && !isAlphanumeric(before ?? '') && !standsAlone(before, after)
    default:
      return false
  }
}

// 両隣が空白か行の端の 1 文字は開きも閉じもしないが、2 文字以上の連なりは内側の文字が閉じ記号になりうる。
function standsAlone(before: string | undefined, after: string | undefined): boolean {
  return (before === undefined || isSpace(before)) && (after === undefined || isSpace(after))
}

function followedBy(line: Glyph[], index: number, text: string): boolean {
  return Array.from(text).every((char, offset) => line[index + 1 + offset]?.char === char)
}

function splitLines(glyphs: Glyph[]): Glyph[][] {
  const lines: Glyph[][] = []
  let line: Glyph[] = []
  for (const glyph of glyphs) {
    if (glyph.char === '\n') {
      lines.push(line)
      line = []
    } else {
      line.push(glyph)
    }
  }
  lines.push(line)
  return lines
}

// 表は続く行と合わせて読むので、続く行の escape を決めてから前の行を見る。
function escapeLineStarts(lines: Glyph[][], lineStart: LineStart): void {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    const marker = index === 0 && lineStart.kind === 'afterMarker' ? lineStart.marker : null
    // delimiter の行は、`|` を含む前の行を表の header にする。list の項目どうしは空行を挟まないので、印も含めて見る。
    if (isDelimiterLine((marker ?? '') + lineText(line))) escapeLeading(line)
    if (marker !== null) continue
    const next = lines[index + 1]
    while (opensBlockAt(lineText(line), next && lineText(next))) {
      if (!escapeLeading(line)) break
    }
  }
}

// block の構文の印は、どれも行頭から続く素の文字の中にある。
function escapeLeading(line: Glyph[]): boolean {
  for (const glyph of line) {
    if (!glyph.plain) return false
    if (!glyph.escaped && isAsciiPunctuation(glyph.char)) {
      glyph.escaped = true
      return true
    }
  }
  return false
}

function lineText(line: Glyph[]): string {
  return line.map((glyph) => (glyph.escaped ? `\\${glyph.char}` : glyph.char)).join('')
}
