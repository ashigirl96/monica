import Defuddle from 'defuddle'

import { blockOf, type TranslationBlock, UNTRANSLATED } from './markup.ts'

const BLOCKS =
  'p, li, h1, h2, h3, h4, h5, h6, dt, dd, td, th, figcaption, blockquote, summary, caption'
// Defuddle が通常の設定でも出力に残す属性のうち、<track> の外では意味を持たないもの。debug の設定は console に書くので使わない。
const MARK = 'kind'
const LATIN = /[A-Za-z]{2}/

const flat = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim()

type Kept = { kept: Set<Element>; title: string; text: string }

function keptBy(document: Document, all: Element[], url: string, partial: boolean): Kept {
  const result = new Defuddle(document, {
    url,
    removePartialSelectors: partial,
    useAsync: false,
  }).parse()
  // template の中身は inert なので、出力の script も画像も動かない。
  const output = document.createElement('template')
  output.innerHTML = result.content
  const kept = new Set<Element>()
  for (const element of output.content.querySelectorAll(`[${MARK}^="monica-"]`)) {
    const found = all[Number(element.getAttribute(MARK)!.slice('monica-'.length))]
    if (found) kept.add(found)
  }
  const text = flat([...output.content.childNodes].map((node) => node.textContent).join(' '))
  return { kept, title: flat(result.title), text }
}

function commonAncestor(elements: Element[]): Element | undefined {
  let root = elements[0]
  while (root && !elements.every((element) => root!.contains(element))) {
    root = root.parentElement ?? undefined
  }
  return root
}

/**
 * Defuddle が本文に残した要素。目印を付けてから走らせ、出力に残った目印で引く。
 * 既定の設定は class 名の部分一致（frontmatter など）で記事の冒頭の要約まで外し、外さない設定は page によって header のメニューまで残すので、
 * 外さない設定で増えた要素は、既定の設定の本文を包む要素の中のものだけを足す。
 */
function mainElements(document: Document, url: string): Kept {
  const all = [...document.body.querySelectorAll('*')]
  const before = all.map((element) => element.getAttribute(MARK))
  all.forEach((element, i) => element.setAttribute(MARK, `monica-${i}`))
  try {
    const strict = keptBy(document, all, url, true)
    const loose = keptBy(document, all, url, false)
    const root = commonAncestor([...strict.kept])
    for (const element of loose.kept) if (root?.contains(element)) strict.kept.add(element)
    return { kept: strict.kept, title: strict.title, text: `${strict.text} ${loose.text}` }
  } finally {
    all.forEach((element, i) => {
      const value = before[i]
      if (value === null || value === undefined) element.removeAttribute(MARK)
      else element.setAttribute(MARK, value)
    })
  }
}

// Defuddle は見出しや配置用の表を作り直して目印を落とし、題の h1 は本文から外すので、目印の無い段落は包む要素と文で決める。
function isMain(element: Element, main: Kept): boolean {
  if (main.kept.has(element)) return true
  const text = flat(element.textContent)
  if (
    element.localName === 'h1' &&
    main.title.includes(text) &&
    text.length * 2 >= main.title.length
  ) {
    return true
  }
  for (let up = element.parentElement; up; up = up.parentElement) {
    if (main.kept.has(up)) return main.text.includes(text)
  }
  return false
}

const NAVIGATION =
  'nav, menu, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="menu"], [role="menubar"]'

/** ページの骨組み（ナビゲーションと、記事の外の header・footer・aside）の中にある。記事の中の header は記事の題などなので含めない。 */
export function isPageChrome(element: Element): boolean {
  if (element.closest(NAVIGATION)) return true
  const landmark = element.closest('header, footer, aside')
  return landmark !== null && landmark.parentElement?.closest('article, section') == null
}

/** Current Page の本文の TranslationBlock を、page の順に並べる。 */
export function bodyBlocks(document: Document, url: string): TranslationBlock[] {
  const main = mainElements(document, url)
  const blocks: TranslationBlock[] = []
  for (const element of document.querySelectorAll(BLOCKS)) {
    if (element.closest(UNTRANSLATED) || (element as HTMLElement).isContentEditable) continue
    if (isPageChrome(element) || !isMain(element, main)) continue
    const block = blockOf(element)
    if (block && LATIN.test(block.text.replace(/<[^>]+>/g, ''))) blocks.push(block)
  }
  return blocks
}
