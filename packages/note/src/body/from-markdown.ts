import { IMAGE_URL_PREFIX } from './image-url.ts'
import {
  hasSpace,
  isAlphanumeric,
  isAsciiPunctuation,
  isSpace,
  isSpacePadded,
  lines,
  trim,
  trimEnd,
} from './text.ts'

type Mark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' }
  | { type: 'link'; attrs: { href: string } }

type TextNode = { type: 'text'; text: string; marks?: Mark[] }

type Inline =
  | TextNode
  | { type: 'noteMention'; attrs: { noteId: string }; marks?: Mark[] }
  | { type: 'hardBreak' }

type MarkdownBlock = {
  type: string
  attrs?: Record<string, unknown>
  content?: (MarkdownBlock | Inline)[]
}

type Construct = { nodes: Inline[]; consumed: number }

type Line = { indent: number; rest: string }

const TAB_WIDTH = 4

// 1 段ごとに parseBlocks と parseBlock が再帰するので、字下げが段々に深まるだけの入力で stack を溢れさせないよう、ここから先は平らにする。
const MAX_NEST_DEPTH = 64

// ProseMirror は schema の mark の順で持つ。
const MARK_ORDER = ['bold', 'italic', 'underline', 'strike', 'code', 'link']

const ROMAN_MARKERS = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'])

/**
 * markdown を本文の JSON（doc → blockGroup → blockContainer）に読む。失敗せず、どの構文にも
 * 当たらない行は paragraph にする。block の id は振らない（貼り付けの経路が振る）。
 *
 * toMarkdown と往復しないもの: toggle は quote に、list 以外の block の子は平らになる。
 * `[[note-N|名前]]` の名前は捨てる。見出しの中の改行は、続く行を別の block として読む。
 */
export function fromMarkdown(markdown: string): {
  type: 'doc'
  content: [{ type: 'blockGroup'; content: MarkdownBlock[] }]
} {
  const parser = new Parser(lines(markdown).map(toLine))
  return { type: 'doc', content: [{ type: 'blockGroup', content: parser.parseBlocks(0, 0) }] }
}

/** 本文の 1 行を読んだとき、paragraph の行ではなく block を始めるか。表は続く行 `next` と合わせて決まる。 */
export function opensBlockAt(text: string, next: string | undefined): boolean {
  const line = toLine(text)
  return new Parser(next === undefined ? [line] : [line, toLine(next)]).opensBlock(line)
}

/** 表の delimiter の行（`| --- |`・`--- | ---`）として読むか。 */
export function isDelimiterLine(text: string): boolean {
  const cells = tableRowCells(toLine(text).rest, true)
  return cells !== null && isDelimiterRow(cells)
}

function toLine(raw: string): Line {
  let indent = 0
  let offset = 0
  for (; offset < raw.length; offset++) {
    if (raw[offset] === ' ') indent += 1
    else if (raw[offset] === '\t') indent += TAB_WIDTH
    else break
  }
  return { indent, rest: raw.slice(offset) }
}

class Parser {
  private readonly lines: Line[]
  private pos = 0

  constructor(source: Line[]) {
    this.lines = source
  }

  parseBlocks(minIndent: number, depth: number): MarkdownBlock[] {
    const out: MarkdownBlock[] = []
    for (;;) {
      while (this.lines[this.pos]?.rest === '') this.pos++
      const line = this.lines[this.pos]
      if (!line || line.indent < minIndent) return out
      this.parseBlock(line, depth, out)
    }
  }

  // 後に続く深い字下げの行はこの block の子にする。カーソルを置けない block は子を持てないので、子を同じ段へ上げる。
  private parseBlock(line: Line, depth: number, out: MarkdownBlock[]): void {
    const content = this.tryMultilineBlock(line) ?? this.parseLineBlock(line)
    const children = depth + 1 < MAX_NEST_DEPTH ? this.parseBlocks(line.indent + 1, depth + 1) : []
    if (!isAtom(content)) {
      out.push(container(content, children))
      return
    }
    out.push(container(content, []))
    for (const child of children) out.push(child)
  }

  // どの構文でもなければ、読む位置を動かさない。
  private tryMultilineBlock(line: Line): MarkdownBlock | null {
    return (
      this.tryCodeBlock(line) ??
      this.tryCallout(line) ??
      this.tryQuote(line) ??
      this.trySyncedBlock(line) ??
      this.tryTable(line)
    )
  }

  // 1 つの段落や list item を折り返した入力を 1 つの block に戻すため、同じ字下げの素の行が続く間は hardBreak でつなぐ。
  private parseLineBlock(line: Line): MarkdownBlock {
    const parsed = singleLineBlock(line.rest)
    this.pos++
    if (!CONTINUED.has(parsed.type)) return parsed
    for (;;) {
      const next = this.lines[this.pos]
      if (!next || next.rest === '' || next.indent !== line.indent || this.opensBlock(next)) break
      const inlines = (parsed.content ??= [])
      inlines.push({ type: 'hardBreak' })
      parseInlineInto(next.rest, [], inlines as Inline[])
      this.pos++
    }
    return parsed
  }

  // 実際に読んでみて位置を戻すので、新しい block を始めるかの判定が読む側とずれない。
  opensBlock(line: Line): boolean {
    const saved = this.pos
    const multiline = this.tryMultilineBlock(line) !== null
    this.pos = saved
    return multiline || singleLineBlock(line.rest).type !== 'paragraph'
  }

  // 閉じる fence が無ければ、最後までをコードにする。
  private tryCodeBlock(line: Line): MarkdownBlock | null {
    const text = line.rest
    const fenceChar = text[0]
    if (fenceChar !== '`' && fenceChar !== '~') return null
    let fenceLength = 0
    while (text[fenceLength] === fenceChar) fenceLength++
    if (fenceLength < 3) return null
    const info = trim(text.slice(fenceLength))
    if (fenceChar === '`' && info.includes('`')) return null
    this.pos++
    const code: string[] = []
    for (let next = this.lines[this.pos]; next; next = this.lines[this.pos]) {
      this.pos++
      if (isClosingFence(next.rest, fenceChar, fenceLength)) break
      // 自分の字下げだけを外し、それより深い分はコードとして残す。
      code.push(' '.repeat(Math.max(next.indent - line.indent, 0)) + next.rest)
    }
    const joined = code.join('\n')
    // 言語が無ければ attrs ごと省き、schema の既定に任せる。
    return block(
      'codeBlock',
      info ? { language: info } : null,
      joined ? [{ type: 'text', text: joined }] : null,
    )
  }

  private tryCallout(line: Line): MarkdownBlock | null {
    const kind = calloutKind(line.rest)
    if (kind === null) return null
    this.pos++
    return block('callout', { kind }, parseMultilineInlines(this.quoteLines(line.indent)))
  }

  private tryQuote(line: Line): MarkdownBlock | null {
    if (quoteBody(line.rest) === null) return null
    return block('quote', null, parseMultilineInlines(this.quoteLines(line.indent)))
  }

  private quoteLines(indent: number): string[] {
    const body: string[] = []
    for (let next = this.lines[this.pos]; next; next = this.lines[this.pos]) {
      if (next.indent !== indent || calloutKind(next.rest) !== null) break
      const rest = quoteBody(next.rest)
      if (rest === null) break
      body.push(rest)
      this.pos++
    }
    return body
  }

  // 同じ Note の block を指す行が続けば 1 つの Synced Block にまとめる。toMarkdown が 1 つの Synced Block を行に分けて書く形の逆。
  private trySyncedBlock(line: Line): MarkdownBlock | null {
    const first = syncedRef(line.rest)
    if (!first) return null
    this.pos++
    const blockIds: string[] = []
    if (first.blockId !== null) {
      blockIds.push(first.blockId)
      for (let next = this.lines[this.pos]; next; next = this.lines[this.pos]) {
        if (next.indent !== line.indent) break
        const ref = syncedRef(next.rest)
        if (!ref || ref.blockId === null || ref.noteId !== first.noteId) break
        blockIds.push(ref.blockId)
        this.pos++
      }
    }
    return block('syncedBlock', { noteId: first.noteId, blockIds }, null)
  }

  /**
   * GFM の表。同じ字下げで続く行を 1 つの表にし、2 行目が delimiter の行なら 1 行目を header にする。
   * `|` だけの行は本文にもあるので、2 行以上そろったときだけ表として読む。
   */
  private tryTable(line: Line): MarkdownBlock | null {
    const start = this.pos
    // 表の行は必ず `|` を含む。続く行ごとに opensBlock がここを通るので、素の本文で次の行まで分けない。
    if (!line.rest.includes('|')) return null
    // 先頭の `|` を省いた行（`a | b`）は delimiter の行があるときだけ許す。無いのに許すと、` | ` を含む本文の 2 行が表になる。
    const second = this.lines[start + 1]
    const delimiter = second?.indent === line.indent ? tableRowCells(second.rest, true) : null
    const bareOk = delimiter !== null && isDelimiterRow(delimiter)
    if (tableRowCells(line.rest, bareOk) === null) return null
    const rows: string[][] = []
    let header = false
    for (let next = this.lines[this.pos]; next; next = this.lines[this.pos]) {
      if (next.indent !== line.indent) break
      const cells = tableRowCells(next.rest, bareOk)
      if (cells === null) break
      if (rows.length === 1 && !header && isDelimiterRow(cells)) header = true
      else rows.push(cells)
      this.pos++
    }
    if (this.pos - start < 2 || rows.length === 0) {
      this.pos = start
      return null
    }
    const width = rows.reduce((widest, cells) => Math.max(widest, cells.length), 1)
    return block(
      'table',
      null,
      rows.map((cells, index) =>
        block(
          'tableRow',
          null,
          Array.from({ length: width }, (_, column) =>
            block(
              'tableCell',
              header && index === 0 ? { header: true } : null,
              parseInlines(cells[column] ?? ''),
            ),
          ),
        ),
      ),
    )
  }
}

// 見出しは CommonMark と同じく 1 行で閉じるので、続く行を受けない。
const CONTINUED = new Set(['paragraph', 'bullet', 'todo', 'numbered'])

// table も、エディタが子を入れさせないのに揃えて子を持たせない。
const ATOMS = new Set(['divider', 'image', 'syncedBlock', 'table'])

function isAtom(node: MarkdownBlock): boolean {
  return ATOMS.has(node.type)
}

function container(content: MarkdownBlock, children: MarkdownBlock[]): MarkdownBlock {
  return {
    type: 'blockContainer',
    content: children.length > 0 ? [content, { type: 'blockGroup', content: children }] : [content],
  }
}

function block(
  type: string,
  attrs: Record<string, unknown> | null,
  content: (MarkdownBlock | Inline)[] | null,
): MarkdownBlock {
  const node: MarkdownBlock = { type }
  if (attrs) node.attrs = attrs
  if (content) node.content = content
  return node
}

function singleLineBlock(text: string): MarkdownBlock {
  if (isThematicBreak(text)) return { type: 'divider' }
  return (
    heading(text) ??
    todo(text) ??
    bullet(text) ??
    numbered(text) ??
    image(text) ??
    block('paragraph', null, parseInlines(text))
  )
}

function isThematicBreak(text: string): boolean {
  const line = trimEnd(text)
  const first = line[0]
  if (first !== '-' && first !== '*' && first !== '_') return false
  return line.length >= 3 && line === first.repeat(line.length)
}

function heading(text: string): MarkdownBlock | null {
  let hashes = 0
  while (text[hashes] === '#') hashes++
  if (hashes === 0 || hashes > 6) return null
  const body = afterMarker(text.slice(hashes))
  if (body === null) return null
  // エディタの見出しは 1〜3 なので、4 以降は 3 に丸める。
  return block('heading', { level: Math.min(hashes, 3) }, parseInlines(body))
}

/** `- [ ] text`・`* [x] text` と、印を省いた `[ ] text`（input rule と同じ範囲）。 */
function todo(text: string): MarkdownBlock | null {
  const rest = stripListMarker(text) ?? text
  let checked: boolean
  let after: string
  if (rest.startsWith('[x]') || rest.startsWith('[X]')) {
    checked = true
    after = rest.slice(3)
  } else if (rest.startsWith('[ ]')) {
    checked = false
    after = rest.slice(3)
  } else if (rest.startsWith('[]')) {
    checked = false
    after = rest.slice(2)
  } else {
    return null
  }
  const body = afterMarker(after)
  if (body === null) return null
  return block('todo', { checked }, parseInlines(body))
}

function bullet(text: string): MarkdownBlock | null {
  const body = stripListMarker(text)
  return body === null ? null : block('bullet', null, parseInlines(body))
}

function stripListMarker(text: string): string | null {
  return text.startsWith('- ') || text.startsWith('* ') || text.startsWith('+ ')
    ? text.slice(2)
    : null
}

/**
 * `1. `・`1) ` は decimal、`a. ` は lower-alpha、`i. ` は lower-roman。roman を alpha より先に見る（input rule と同じ）。
 * 番号は表示が振るので捨てる。
 */
function numbered(text: string): MarkdownBlock | null {
  const separator = text.search(/[.)]/)
  if (separator <= 0) return null
  const marker = text.slice(0, separator)
  if (marker.length > 4) return null
  let style: string
  if (/^[0-9]+$/.test(marker)) {
    if (marker.length > 3) return null
    style = 'decimal'
  } else if (text[separator] === '.' && /^[a-z]+$/.test(marker)) {
    if (ROMAN_MARKERS.has(marker)) style = 'lower-roman'
    else if (marker.length === 1) style = 'lower-alpha'
    else return null
  } else {
    return null
  }
  const body = afterMarker(text.slice(separator + 1))
  if (body === null) return null
  return block('numbered', { style }, parseInlines(body))
}

// 印の直後は行末か空白 1 つ。`#hashtag` や `e.g.` を block の印と読まない。
function afterMarker(rest: string): string | null {
  if (rest === '') return ''
  return rest.startsWith(' ') ? rest.slice(1) : null
}

function calloutKind(text: string): string | null {
  const rest = text.startsWith('> [!')
    ? text.slice(4)
    : text.startsWith('>[!')
      ? text.slice(3)
      : null
  if (rest === null) return null
  const end = rest.indexOf(']')
  if (end === -1) return null
  const kind = rest.slice(0, end)
  return /^[A-Za-z0-9_-]+$/.test(kind) && trim(rest.slice(end + 1)) === '' ? kind : null
}

function quoteBody(text: string): string | null {
  if (!text.startsWith('>')) return null
  const rest = text.slice(1)
  return rest.startsWith(' ') ? rest.slice(1) : rest
}

function isClosingFence(text: string, fenceChar: string, minLength: number): boolean {
  const line = trimEnd(text)
  return line.length >= minLength && line === fenceChar.repeat(line.length)
}

/**
 * `| a | b |` の行をセルに分ける。末尾の `|` は省いてよく、`bareOk` なら先頭の `|` も省いてよい
 * （その代わりに区切りの `|` を 1 つ以上求め、本文の 1 行を表の行と読まない）。cmark-gfm と同じく、
 * 直前が `\` の `|` では区切らない。セルの `\|` は、backslash の escape が効かない code span・
 * Note Mention・href の中でも `|` と読むよう、inline として読む前に `|` に戻す。
 */
function tableRowCells(text: string, bareOk: boolean): string[] | null {
  const line = trimEnd(text)
  const bare = !line.startsWith('|')
  if (bare && !bareOk) return null
  const cells = (bare ? line : line.slice(1)).split(/(?<!\\)\|/)
  if (cells.length > 1 && cells.at(-1) === '') cells.pop()
  if (bare && cells.length < 2) return null
  return cells.map((cell) => trim(cell.replaceAll('\\|', '|')))
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function syncedRef(text: string): { noteId: string; blockId: string | null } | null {
  const line = trimEnd(text)
  if (!line.startsWith('![[') || !line.endsWith(']]')) return null
  const inner = line.slice(3, -2)
  if (inner === '' || inner.includes('[') || inner.includes(']')) return null
  const hash = inner.indexOf('#^')
  if (hash === -1) return { noteId: inner, blockId: null }
  const noteId = inner.slice(0, hash)
  const blockId = inner.slice(hash + 2)
  return noteId && blockId ? { noteId, blockId } : null
}

/** 行全体が `![alt](src)` のときだけ画像にする。src はエディタの貼り付けと同じく、画像の置き場所か http(s) だけを受ける。 */
function image(text: string): MarkdownBlock | null {
  const line = trimEnd(text)
  if (!line.startsWith('![')) return null
  const inner = line.slice(2)
  const close = inner.indexOf(']')
  if (close === -1) return null
  const target = inner.slice(close + 1)
  if (!target.startsWith('(') || !target.endsWith(')')) return null
  const src = target.slice(1, -1)
  const acceptable =
    !hasSpace(src) &&
    !src.includes(')') &&
    (src.startsWith(IMAGE_URL_PREFIX) || src.startsWith('http://') || src.startsWith('https://'))
  return acceptable ? block('image', { src }, null) : null
}

function parseInlines(text: string): Inline[] | null {
  const out: Inline[] = []
  parseInlineInto(text, [], out)
  return out.length > 0 ? out : null
}

function parseMultilineInlines(body: string[]): Inline[] | null {
  if (body.every((line) => line === '')) return null
  const out: Inline[] = []
  body.forEach((line, index) => {
    if (index > 0) out.push({ type: 'hardBreak' })
    parseInlineInto(line, [], out)
  })
  return out.length > 0 ? out : null
}

function parseInlineInto(text: string, marks: Mark[], out: Inline[]): void {
  let plain = ''
  let index = 0
  while (index < text.length) {
    // CommonMark と同じく、ASCII の記号だけを escape できる。
    const next = text.charAt(index + 1)
    if (text[index] === '\\' && isAsciiPunctuation(next)) {
      plain += next
      index += 2
      continue
    }
    const construct = tryConstruct(text, index, marks)
    if (construct) {
      flushPlain(plain, marks, out)
      plain = ''
      for (const node of construct.nodes) pushNode(out, node)
      index += construct.consumed
      continue
    }
    plain += text.charAt(index)
    index += 1
  }
  flushPlain(plain, marks, out)
}

function tryConstruct(text: string, offset: number, marks: Mark[]): Construct | null {
  switch (text[offset]) {
    case '`':
      return codeSpan(text.slice(offset), marks)
    case '[': {
      const rest = text.slice(offset)
      return noteMention(rest, marks) ?? link(rest, marks)
    }
    case '*': {
      const rest = text.slice(offset)
      return (
        emphasis(rest, '***', ['bold', 'italic'], marks) ??
        emphasis(rest, '**', ['bold'], marks) ??
        emphasis(rest, '*', ['italic'], marks)
      )
    }
    case '_': {
      // 語の中の `_` は強調にしない（snake_case を守る。CommonMark と同じ）。
      if (isAlphanumeric(charBefore(text, offset))) return null
      const rest = text.slice(offset)
      return (
        emphasis(rest, '___', ['bold', 'italic'], marks) ??
        emphasis(rest, '__', ['bold'], marks) ??
        emphasis(rest, '_', ['italic'], marks)
      )
    }
    case '~': {
      const rest = text.slice(offset)
      return emphasis(rest, '~~', ['strike'], marks) ?? emphasis(rest, '~', ['strike'], marks)
    }
    case '<':
      return underline(text.slice(offset), marks)
    default:
      return null
  }
}

/** 対の delimiter で囲んだ強調。中身は空でなく、両端が空白でないこと（input rule と同じ）。 */
function emphasis(
  rest: string,
  delimiter: string,
  added: ('bold' | 'italic' | 'strike')[],
  marks: Mark[],
): Construct | null {
  if (!rest.startsWith(delimiter)) return null
  const inner = rest.slice(delimiter.length)
  let from = 0
  for (;;) {
    const end = indexOfUnescaped(inner, delimiter, from)
    if (end <= 0) return null
    const content = inner.slice(0, end)
    if (isSpace(content[0])) return null
    if (isSpace(content.at(-1))) {
      from = end + 1
      continue
    }
    const nodes: Inline[] = []
    parseInlineInto(content, [...marks, ...added.map((type) => ({ type }))], nodes)
    return { nodes, consumed: delimiter.length + end + delimiter.length }
  }
}

function codeSpan(rest: string, marks: Mark[]): Construct | null {
  const span = measureCodeSpan(rest)
  if (!span) return null
  const code = rest.slice(span.ticks, span.ticks + span.length)
  return {
    nodes: [textNode(unpadCode(code), [...marks, { type: 'code' }])],
    consumed: span.ticks * 2 + span.length,
  }
}

/** 先頭の backtick の連なりで開く code span の、連なりの長さと中身の長さ。CommonMark と同じく、同じ長さの連なりで閉じる。 */
function measureCodeSpan(rest: string): { ticks: number; length: number } | null {
  let ticks = 0
  while (rest[ticks] === '`') ticks++
  let index = ticks
  while (index < rest.length) {
    if (rest[index] !== '`') {
      index++
      continue
    }
    const runStart = index
    while (rest[index] === '`') index++
    if (index - runStart === ticks) return { ticks, length: runStart - ticks }
  }
  return null
}

// backtick で始まるか終わる中身は、包む backtick とつながらないよう空白で挟んで書かれる（CommonMark と同じ）。
function unpadCode(code: string): string {
  return isSpacePadded(code) ? code.slice(1, -1) : code
}

// `[[note-N|名前]]` の名前は捨てる。表示名はエディタが引く。
function noteMention(rest: string, marks: Mark[]): Construct | null {
  if (!rest.startsWith('[[')) return null
  const inner = rest.slice(2)
  const end = indexOfUnescaped(inner, ']]')
  if (end === -1) return null
  const body = inner.slice(0, end)
  const bar = body.indexOf('|')
  const noteId = bar === -1 ? body : body.slice(0, bar)
  const name = bar === -1 ? '' : body.slice(bar + 1)
  if (noteId === '' || /[[\]]/.test(noteId) || noteId.includes('#^')) return null
  if (indexOfUnescaped(name, '[') !== -1 || indexOfUnescaped(name, ']') !== -1) return null
  const sorted = sortMarks(marks)
  return {
    nodes: [{ type: 'noteMention', attrs: { noteId }, ...(sorted ? { marks: sorted } : {}) }],
    consumed: 2 + end + 2,
  }
}

function link(rest: string, marks: Mark[]): Construct | null {
  if (!rest.startsWith('[')) return null
  const inner = rest.slice(1)
  const close = indexOfUnescaped(inner, ']')
  if (close === -1) return null
  const label = inner.slice(0, close)
  const after = inner.slice(close + 1)
  if (!after.startsWith('(')) return null
  const target = after.slice(1)
  const paren = hrefEnd(target)
  if (paren === -1) return null
  const href = target.slice(0, paren)
  if (href === '' || hasSpace(href)) return null
  const linked: Mark[] = [...marks, { type: 'link', attrs: { href } }]
  const nodes: Inline[] = []
  if (label === '') nodes.push(textNode(href, linked))
  else parseInlineInto(label, linked, nodes)
  return { nodes, consumed: 1 + close + 2 + paren + 1 }
}

// `(` を数えて釣り合う `)` で閉じる。Wikipedia の `.../Foo_(film)` のように href が括弧を含むため。
function hrefEnd(target: string): number {
  let depth = 0
  for (let index = 0; index < target.length; index++) {
    if (target[index] === '(') depth++
    else if (target[index] === ')') {
      if (depth === 0) return index
      depth--
    }
  }
  return -1
}

function underline(rest: string, marks: Mark[]): Construct | null {
  if (!rest.startsWith('<u>')) return null
  const inner = rest.slice(3)
  const end = indexOfUnescaped(inner, '</u>')
  if (end <= 0) return null
  const nodes: Inline[] = []
  parseInlineInto(inner.slice(0, end), [...marks, { type: 'underline' }], nodes)
  return { nodes, consumed: 3 + end + 4 }
}

// CommonMark と同じく、閉じ記号を探すときは backslash で escape した文字と code span の中を飛ばす。
function indexOfUnescaped(text: string, search: string, from = 0): number {
  let index = from
  while (index < text.length) {
    if (text[index] === '\\' && isAsciiPunctuation(text.charAt(index + 1))) {
      index += 2
      continue
    }
    if (text.startsWith(search, index)) return index
    // 閉じない backtick は parseInlineInto と同じく 1 文字ずつ進め、続きの短い連なりで開くかを見る。
    const span = text[index] === '`' ? measureCodeSpan(text.slice(index)) : null
    index += span ? span.ticks * 2 + span.length : 1
  }
  return -1
}

function flushPlain(plain: string, marks: Mark[], out: Inline[]): void {
  if (plain) pushNode(out, textNode(plain, marks))
}

// 直前と同じ mark の text はつなぎ、`*a*b` の後半のような断片を 1 つの node にする。
function pushNode(out: Inline[], node: Inline): void {
  const last = out.at(-1)
  if (last?.type === 'text' && node.type === 'text' && sameMarks(last.marks, node.marks)) {
    last.text += node.text
    return
  }
  out.push(node)
}

function textNode(text: string, marks: Mark[]): TextNode {
  const sorted = sortMarks(marks)
  return sorted ? { type: 'text', text, marks: sorted } : { type: 'text', text }
}

// 同じ mark の入れ子（`*a _b_*` など）は 1 つに畳む。重なった mark は ProseMirror の check() が落とす。
function sortMarks(marks: Mark[]): Mark[] | null {
  if (marks.length === 0) return null
  const sorted = marks.toSorted((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
  return sorted.filter((mark, index) => index === 0 || !sameMark(sorted[index - 1], mark))
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((mark, index) => sameMark(mark, b[index]))
}

function sameMark(a: Mark | undefined, b: Mark | undefined): boolean {
  if (a === undefined || b === undefined || a.type !== b.type) return false
  return a.type !== 'link' || (b.type === 'link' && a.attrs.href === b.attrs.href)
}

/** offset の直前の 1 文字。surrogate pair は 2 つで 1 文字に数える。 */
function charBefore(text: string, offset: number): string {
  const pair = text.slice(Math.max(offset - 2, 0), offset)
  return /^[\ud800-\udbff][\udc00-\udfff]$/.test(pair) ? pair : text.slice(offset - 1, offset)
}
