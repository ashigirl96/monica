/** 訳す単位の 1 つ。element の行内の node を、行内の要素を印にした文で表す。 */
export type TranslationBlock = {
  element: Element
  nodes: ChildNode[]
  /** 印の番号から要素を引く。 */
  map: Element[]
  text: string
}

export type TranslatedNode = string | { element: Element; kids: TranslatedNode[]; copy?: true }

/** 書き戻す前の状態。text node は元の文字、要素は元の子の並び、足した node は null。 */
export type Originals = Map<Node, string | ChildNode[] | null>

// 段落の中で行を切る要素。その中身は別の TranslationBlock になる。
const BREAKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])
// 中身を訳さずに、印 1 つとしてそのまま残す要素。
const ATOMIC = new Set([
  'audio',
  'br',
  'button',
  'canvas',
  'code',
  'iframe',
  'img',
  'input',
  'kbd',
  'math',
  'samp',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'var',
  'video',
  'wbr',
])

export const UNTRANSLATED =
  'pre, code, script, style, noscript, textarea, [translate="no"], .notranslate'

const isElement = (node: Node): node is Element => node.nodeType === 1
const isText = (node: Node): node is Text => node.nodeType === 3

function isAtomic(element: Element): boolean {
  return ATOMIC.has(element.localName) || element.matches(UNTRANSLATED)
}

const escaped = (text: string) =>
  text.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))

const unescaped = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function serialize(nodes: ChildNode[], map: Element[]): string {
  let text = ''
  for (const node of nodes) {
    if (isText(node)) text += escaped(node.data)
    else if (isElement(node)) {
      const id = map.push(node) - 1
      text += isAtomic(node)
        ? `<x${id}/>`
        : `<g${id}>${serialize([...node.childNodes], map)}</g${id}>`
    }
  }
  return text
}

/** element の行内の node。行を切る子要素とその後ろの中身は含めない。 */
export function inlineNodes(element: Element): ChildNode[] {
  const nodes = [...element.childNodes]
  const end = nodes.findIndex((node) => isElement(node) && BREAKS.has(node.localName))
  return end < 0 ? nodes : nodes.slice(0, end)
}

/** 行内の node が文字を持たなければ undefined。 */
export function blockOf(element: Element): TranslationBlock | undefined {
  const nodes = inlineNodes(element)
  if (!nodes.some((node) => node.textContent?.trim())) return undefined
  const map: Element[] = []
  const text = serialize(nodes, map).replace(/\s+/g, ' ').trim()
  return { element, nodes, map, text }
}

// 描き直しで要素が外れたか中身が変わった TranslationBlock に、切り出した時の印で書くと別の node に入る。
export function unchangedSince(block: TranslationBlock): boolean {
  return (
    block.element.isConnected &&
    block.nodes.every((node) => node.parentNode === block.element) &&
    blockOf(block.element)?.text === block.text
  )
}

/** 書いた後の行内を、次に見たときに変わったかを比べるための文。 */
export function currentText(element: Element): string {
  return serialize(inlineNodes(element), []).replace(/\s+/g, ' ').trim()
}

const tagOf = (id: number, atomic: boolean) => (atomic ? `<x${id}/>` : `<g${id}>`)

type Frame = { id: number | undefined; kids: TranslatedNode[] }

/**
 * 訳文を木にする。印がそろい入れ子が閉じていなければ error を返す。
 * lenient では、2 度目の <xN/> を要素の写しにし、知らない印は外して中の文字を残す。欠けた印はどちらでも断る。
 */
export function parseTranslation(
  text: string,
  map: Element[],
  { lenient = false }: { lenient?: boolean } = {},
): { kids: TranslatedNode[] } | { error: string } {
  const root: Frame = { id: undefined, kids: [] }
  const stack: Frame[] = []
  let top = root
  const seen = new Set<number>()
  for (const match of text.matchAll(/<(\/?)([gx])(\d+)(\/?)>|[^<]+|</g)) {
    const [token, close, kind, digits, selfClosing] = match
    if (kind === undefined) {
      top.kids.push(unescaped(token))
      continue
    }
    const id = Number(digits)
    const element = map[id]
    const fits = element !== undefined && isAtomic(element) === (kind === 'x')
    if (close) {
      if (top.id !== id) {
        if (lenient && !fits && !seen.has(id)) continue
        return { error: `misnested </${kind}${id}>` }
      }
      top = stack.pop() ?? root
      continue
    }
    if (!element || !fits || (kind === 'x') !== (selfClosing === '/')) {
      if (!lenient) return { error: `unknown ${tagOf(id, kind === 'x')}` }
      continue
    }
    if (seen.has(id)) {
      if (lenient && kind === 'x') {
        top.kids.push({ element, kids: [], copy: true })
        continue
      }
      return { error: `repeated ${tagOf(id, kind === 'x')}` }
    }
    seen.add(id)
    const node = { element, kids: [] }
    top.kids.push(node)
    if (kind === 'g') {
      stack.push(top)
      top = { id, kids: node.kids }
    }
  }
  if (top !== root) return { error: `unclosed <g${top.id}>` }
  const missing = map.findIndex((_, id) => !seen.has(id))
  const element = map[missing]
  if (element) return { error: `missing ${tagOf(missing, isAtomic(element))}` }
  return { kids: root.kids }
}

const wrote = new WeakMap<Text, string>()

// React が覚えている node を消すと後の描き直しで removeChild が落ちるので、元の node は消さずに、文字の差し替えと並べ替えだけをする。
function write(parent: Element, own: ChildNode[], kids: TranslatedNode[], originals: Originals) {
  if (!originals.has(parent)) originals.set(parent, [...parent.childNodes])
  const texts = own.filter(isText)
  // 前に書いた後でページが同じ text node を書き換えていたら、その文を原文に取り直す。
  for (const text of texts) {
    if (!originals.has(text) || wrote.get(text) !== text.data) originals.set(text, text.data)
  }
  const order: ChildNode[] = []
  let used = 0
  for (const kid of kids) {
    if (typeof kid === 'string') {
      let text = texts[used++]
      if (!text) {
        text = parent.ownerDocument.createTextNode('')
        originals.set(text, null)
      }
      text.data = kid
      wrote.set(text, kid)
      order.push(text)
    } else if (kid.copy) {
      const copy = kid.element.cloneNode(true) as Element
      originals.set(copy, null)
      order.push(copy)
    } else {
      order.push(kid.element)
      if (!isAtomic(kid.element)) {
        write(kid.element, [...kid.element.childNodes], kid.kids, originals)
      }
    }
  }
  for (const text of texts.slice(used)) {
    text.data = ''
    wrote.set(text, '')
  }
  const anchor = own.at(-1)?.nextSibling ?? null
  for (const node of order) parent.insertBefore(node, anchor)
}

export function writeTranslation(
  block: TranslationBlock,
  kids: TranslatedNode[],
  originals: Originals,
): void {
  write(block.element, block.nodes, kids, originals)
}

/** 書き戻す前に戻す。描き直しで page から外れた node は、戻しても見えないまま捨てられる。 */
export function restoreOriginals(originals: Originals): void {
  for (const [node, saved] of originals) {
    if (saved === null) (node as ChildNode).remove()
    else if (typeof saved === 'string') (node as Text).data = saved
  }
  for (const [node, saved] of originals) {
    if (!Array.isArray(saved)) continue
    // ページが外した子は戻さない。React が覚えていない node を親に足すことになる。
    for (const child of saved) if (child.parentNode === node) (node as Element).append(child)
  }
  originals.clear()
}
