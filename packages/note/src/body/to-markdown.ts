import { allText, attrOf, childrenOf, isNode, stringAttr, typeOf } from './node.ts'
import { lines, trim } from './text.ts'

/** Note Mention が指す Note の表示名。分からなければ null を返し、`[[note-N]]` で書き出させる。 */
type NoteName = (noteId: string) => string | null

type Block = { text: string; list: boolean }

/**
 * 本文の JSON を markdown に書き出す。失敗せず、知らない node は text だけを拾う。
 * 型の違う field は無いものとして読む。
 */
export function toMarkdown(doc: unknown, noteName: NoteName = () => null): string {
  if (!isNode(doc)) return ''
  if (doc.type !== 'doc') return trim(allText(doc))
  const blocks: Block[] = []
  renderGroup(childrenOf(doc), blocks, noteName)
  return joinBlocks(blocks)
}

function joinBlocks(blocks: Block[]): string {
  let out = ''
  let prev: Block | undefined
  for (const block of blocks) {
    if (prev) out += prev.list && block.list ? '\n' : '\n\n'
    out += block.text
    prev = block
  }
  return out
}

// numbered の番号はエディタの表示（decorations.ts）と同じく、同じ group で続く同じ style の間だけ進める。
function renderGroup(items: unknown[], out: Block[], noteName: NoteName): void {
  let ordinal = 0
  let ordinalStyle: string | null = null
  for (const item of items) {
    const type = typeOf(item)
    if (type === 'blockGroup') {
      ordinal = 0
      ordinalStyle = null
      renderGroup(childrenOf(item), out, noteName)
      continue
    }
    if (type !== 'blockContainer') {
      ordinal = 0
      ordinalStyle = null
      renderContainer(item, null, [], out, noteName)
      continue
    }
    const [content, ...nested] = childrenOf(item)
    if (content === undefined) continue
    let marker: string | null = null
    if (typeOf(content) === 'numbered') {
      const style = stringAttr(content, 'style') ?? 'decimal'
      if (ordinalStyle !== style) {
        ordinal = 0
        ordinalStyle = style
      }
      marker = markerLabel(style, ordinal)
      ordinal += 1
    } else {
      ordinal = 0
      ordinalStyle = null
    }
    renderContainer(content, marker, nested, out, noteName)
  }
}

function renderContainer(
  content: unknown,
  marker: string | null,
  nested: unknown[],
  out: Block[],
  noteName: NoteName,
): void {
  const block = renderBlockContent(content, marker, noteName)
  if (!block?.list) {
    if (block) out.push(block)
    renderGroup(nested, out, noteName)
    return
  }
  const sub: Block[] = []
  renderGroup(nested, sub, noteName)
  const text =
    sub.length > 0 ? `${block.text}\n${indentLines(joinBlocks(sub), '    ')}` : block.text
  out.push({ text, list: true })
}

function renderBlockContent(
  node: unknown,
  marker: string | null,
  noteName: NoteName,
): Block | null {
  const inline = () => renderInlines(childrenOf(node), noteName)
  switch (typeOf(node)) {
    case 'paragraph': {
      const text = inline()
      return text ? { text, list: false } : null
    }
    case 'heading': {
      const level = attrOf(node, 'level')
      const hashes = Number.isInteger(level) ? Math.min(Math.max(level as number, 1), 6) : 1
      return { text: `${'#'.repeat(hashes)} ${inline()}`, list: false }
    }
    case 'todo':
      return {
        text: `- ${attrOf(node, 'checked') === true ? '[x]' : '[ ]'} ${inline()}`,
        list: true,
      }
    case 'bullet':
      return { text: `- ${inline()}`, list: true }
    case 'numbered':
      return { text: `${marker ?? '1.'} ${inline()}`, list: true }
    case 'quote':
    case 'toggle': {
      const text = inline()
      return text ? { text: prefixLines(text, '> '), list: false } : null
    }
    case 'callout': {
      const body = inline()
      const head = `> [!${stringAttr(node, 'kind') ?? 'note'}]`
      return { text: body ? `${head}\n${prefixLines(body, '> ')}` : head, list: false }
    }
    case 'codeBlock': {
      const code = rawText(childrenOf(node))
      // 中の最長の backtick の連なりより長い fence で包まないと、``` を含む本文で途中で閉じる。
      const fence = '`'.repeat(Math.max(longestBacktickRun(code), 2) + 1)
      return {
        text: `${fence}${stringAttr(node, 'language') ?? ''}\n${code}\n${fence}`,
        list: false,
      }
    }
    case 'table':
      return renderTable(childrenOf(node), noteName)
    case 'tableRow':
      return { text: tableRowLine(childrenOf(node), noteName), list: false }
    case 'tableCell': {
      const text = tableCellText(node, noteName)
      return text ? { text, list: false } : null
    }
    case 'divider':
      return { text: '---', list: false }
    case 'bookmark': {
      const href = stringAttr(node, 'href')
      const title = stringAttr(node, 'title') || undefined
      if (href !== undefined) return { text: linkTo(href, title), list: false }
      return title ? { text: title, list: false } : null
    }
    case 'image': {
      const src = stringAttr(node, 'src')
      return src ? { text: `![](${src})`, list: false } : null
    }
    case 'syncedBlock': {
      const noteId = stringAttr(node, 'noteId')
      if (noteId === undefined) return null
      return { text: syncedReference(noteId, blockIdsOf(node)), list: false }
    }
    case 'blockGroup':
    case 'blockContainer': {
      const sub: Block[] = []
      renderGroup([node], sub, noteName)
      return sub.length > 0 ? { text: joinBlocks(sub), list: false } : null
    }
    default: {
      const text = trim(allText(node))
      return text ? { text, list: false } : null
    }
  }
}

// 先頭の行が header のセルを持つときだけ delimiter の行を挟む。header の無い表に挟むと、読み戻したときに先頭の行が header になる。
function renderTable(rows: unknown[], noteName: NoteName): Block | null {
  const out: string[] = []
  rows.forEach((row, index) => {
    if (typeOf(row) !== 'tableRow') return
    const cells = childrenOf(row)
    out.push(tableRowLine(cells, noteName))
    if (index === 0 && cells.some((cell) => isHeaderCell(cell))) {
      out.push(`| ${cells.map(() => '---').join(' | ')} |`)
    }
  })
  return out.length > 0 ? { text: out.join('\n'), list: false } : null
}

function isHeaderCell(cell: unknown): boolean {
  return typeOf(cell) === 'tableCell' && attrOf(cell, 'header') === true
}

function tableRowLine(cells: unknown[], noteName: NoteName): string {
  const texts = cells.map((cell) =>
    typeOf(cell) === 'tableCell' ? tableCellText(cell, noteName) : '',
  )
  return `| ${texts.join(' | ')} |`
}

// `|` は行の区切りになるので escape する。`\` も重ねないと、セル末尾の `\` が続く `\|` の escape を食い、読み戻すとセルが増える。
function tableCellText(cell: unknown, noteName: NoteName): string {
  return renderInlines(childrenOf(cell), noteName)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
}

function blockIdsOf(node: unknown): string[] {
  const blockIds = attrOf(node, 'blockIds')
  return Array.isArray(blockIds)
    ? blockIds.filter((id): id is string => typeof id === 'string')
    : []
}

function syncedReference(noteId: string, blockIds: string[]): string {
  if (blockIds.length === 0) return `![[${noteId}]]`
  return blockIds.map((blockId) => `![[${noteId}#^${blockId}]]`).join('\n')
}

function renderInlines(inlines: unknown[], noteName: NoteName): string {
  let out = ''
  for (const inline of inlines) {
    if (!isNode(inline)) continue
    switch (inline.type) {
      case 'text':
        if (typeof inline.text === 'string') out += applyMarks(inline.text, inline.marks)
        break
      case 'linkMention': {
        const base = linkMentionText(inline)
        if (base) out += applyMarks(base, inline.marks)
        break
      }
      case 'noteMention': {
        const base = noteMentionText(inline, noteName)
        if (base) out += applyMarks(base, inline.marks)
        break
      }
      case 'hardBreak':
        out += '\n'
        break
      default:
        out += allText(inline)
    }
  }
  return out
}

function linkMentionText(node: unknown): string {
  const href = stringAttr(node, 'href')
  const title = stringAttr(node, 'title') || undefined
  return href === undefined ? (title ?? '') : linkTo(href, title)
}

function linkTo(href: string, title: string | undefined): string {
  return `[${title ?? href}](${href})`
}

function noteMentionText(node: unknown, noteName: NoteName): string {
  const noteId = stringAttr(node, 'noteId')
  if (noteId === undefined) return ''
  const name = noteName(noteId)
  return name ? `[[${noteId}|${name}]]` : `[[${noteId}]]`
}

// code を一番内側、link を一番外側に入れ子にする。underline は markdown に記法が無いので HTML で書く（`__` は CommonMark では bold）。
function applyMarks(base: string, marks: unknown): string {
  let bold = false
  let italic = false
  let underline = false
  let strike = false
  let code = false
  let link: string | null = null
  for (const mark of Array.isArray(marks) ? marks : []) {
    switch (typeOf(mark)) {
      case 'bold':
        bold = true
        break
      case 'italic':
        italic = true
        break
      case 'underline':
        underline = true
        break
      case 'strike':
        strike = true
        break
      case 'code':
        code = true
        break
      case 'link':
        link = stringAttr(mark, 'href') ?? null
        break
    }
  }
  let text = base
  if (code) text = `\`${text}\``
  if (italic) text = `*${text}*`
  if (bold) text = `**${text}**`
  if (underline) text = `<u>${text}</u>`
  if (strike) text = `~~${text}~~`
  if (link !== null) text = `[${text}](${link})`
  return text
}

function rawText(inlines: unknown[]): string {
  let out = ''
  for (const inline of inlines) {
    switch (typeOf(inline)) {
      case 'text':
        if (isNode(inline) && typeof inline.text === 'string') out += inline.text
        break
      case 'hardBreak':
        out += '\n'
        break
      case 'linkMention':
      case 'noteMention':
        break
      default:
        out += allText(inline)
    }
  }
  return out
}

function longestBacktickRun(code: string): number {
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

function prefixLines(text: string, prefix: string): string {
  return lines(text)
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function indentLines(text: string, indent: string): string {
  return lines(text)
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n')
}

function markerLabel(style: string, index: number): string {
  if (style === 'lower-alpha') return `${alphaLabel(index)}.`
  if (style === 'lower-roman') return `${romanLabel(index + 1)}.`
  return `${index + 1}.`
}

// a … z, aa … az, ba … のように 26 進で数える。
function alphaLabel(index: number): string {
  let out = ''
  let rest = index
  for (;;) {
    out = String.fromCharCode(97 + (rest % 26)) + out
    const next = Math.floor(rest / 26)
    if (next === 0) return out
    rest = next - 1
  }
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function romanLabel(value: number): string {
  let out = ''
  let rest = value
  for (const [weight, glyph] of ROMAN) {
    while (rest >= weight) {
      out += glyph
      rest -= weight
    }
  }
  return out
}
