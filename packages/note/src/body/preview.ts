import { childrenOf, isNode } from './node.ts'

const PREVIEW_MAX_CHARS = 200
const graphemes = new Intl.Segmenter()

const TEXTBLOCKS = new Set([
  'paragraph',
  'heading',
  'todo',
  'bullet',
  'numbered',
  'toggle',
  'quote',
  'callout',
  'codeBlock',
  'tableCell',
])
const ATOM_BLOCKS = new Set(['divider', 'bookmark', 'syncedBlock', 'image'])
const ATOM_INLINES = new Set(['linkMention', 'noteMention', 'hardBreak'])

/**
 * 最初の空でない block の text を 200 文字まで。どの block にも text が無ければ null。
 * blockContainer の最初の子がその行の中身なので、block の種類を数えなくても行が取れる。
 */
export function preview(node: unknown): string | null {
  const children = childrenOf(node)
  if (isNode(node) && node.type === 'blockContainer') {
    const text = blockText(children[0], '').trim()
    if (text) return cut(text)
    return firstOf(children.slice(1))
  }
  return firstOf(children)
}

// 見た目の 1 文字で数え、つないだ絵文字を途中で切らない。
function cut(text: string): string {
  return Array.from(graphemes.segment(text), ({ segment }) => segment)
    .slice(0, PREVIEW_MAX_CHARS)
    .join('')
}

function firstOf(nodes: unknown[]): string | null {
  for (const node of nodes) {
    const found = preview(node)
    if (found !== null) return found
  }
  return null
}

function blockText(node: unknown, out: string): string {
  if (!isNode(node)) return out
  const { type } = node
  if (type === 'table' || type === 'tableRow') {
    // 区切らないと隣のセルの語がつながる。
    for (const cell of childrenOf(node)) {
      out = blockText(cell, out && !/\s$/.test(out) ? `${out} ` : out)
    }
    return out
  }
  if (typeof type === 'string' && TEXTBLOCKS.has(type)) {
    for (const inline of childrenOf(node)) out = inlineText(inline, out)
    return out
  }
  if (type === 'blockGroup' || type === 'blockContainer') {
    for (const child of childrenOf(node)) out = blockText(child, out)
    return out
  }
  if (typeof type === 'string' && ATOM_BLOCKS.has(type)) return out
  return out + allText(node)
}

function inlineText(node: unknown, out: string): string {
  if (!isNode(node)) return out
  if (node.type === 'text') return typeof node.text === 'string' ? out + node.text : out
  if (typeof node.type === 'string' && ATOM_INLINES.has(node.type)) return out
  return out + allText(node)
}

function allText(node: unknown): string {
  if (!isNode(node)) return ''
  const own = typeof node.text === 'string' ? node.text : ''
  return own + childrenOf(node).map(allText).join('')
}
