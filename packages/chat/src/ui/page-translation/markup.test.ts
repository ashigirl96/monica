import { expect, test } from 'bun:test'

import { parseHTML } from 'linkedom'

import { blockOf, parseTranslation, restoreOriginals, writeTranslation } from './markup.ts'

function paragraph(html: string) {
  const { document } = parseHTML(`<html><body><article><p>${html}</p></article></body></html>`)
  return { document, p: document.querySelector('p')! }
}

test('a block marks inline elements that hold text as <gN> pairs, untranslated ones as <xN/>, and escapes the text', () => {
  const { p } = paragraph(
    'Use <a href="/x">the <b>guide</b></a> of <code>clientGuide</code> &lt;here&gt; &amp; <img src="a.png"> there',
  )

  expect(blockOf(p)?.text).toBe(
    'Use <g0>the <g1>guide</g1></g0> of <x2/> &lt;here&gt; &amp; <x3/> there',
  )
})

test('a block keeps only the inline content of its element, leaving out the nested lists and paragraphs', () => {
  const { document } = parseHTML(
    '<html><body><ul><li>Outer <em>item</em><ul><li>Inner item</li></ul></li></ul></body></html>',
  )

  expect(blockOf(document.querySelector('li')!)?.text).toBe('Outer <g0>item</g0>')
})

test('a translation that keeps every tag is written into the same nodes, moving elements to its word order', () => {
  const { p } = paragraph('You have <b>1</b> new messages in your <a href="#">inbox</a>.')
  const b = p.querySelector('b')
  const a = p.querySelector('a')
  const [first, middle] = [p.childNodes[0], p.childNodes[2]]
  const block = blockOf(p)!
  const parsed = parseTranslation('<g1>受信箱</g1>に新着が<g0>1</g0>件あります。', block.map)
  if ('error' in parsed) throw new Error(parsed.error)

  writeTranslation(block, parsed.kids, new Map())

  expect(p.innerHTML).toBe('<a href="#">受信箱</a>に新着が<b>1</b>件あります。')
  expect(p.querySelector('b')).toBe(b)
  expect(p.querySelector('a')).toBe(a)
  const texts = [...p.childNodes].filter((node) => node.nodeType === 3)
  expect(texts.find((node) => node.textContent === 'に新着が')).toBe(first!)
  expect(texts.find((node) => node.textContent === '件あります。')).toBe(middle!)
})

test('a written block goes back to its original text and order', () => {
  const { p } = paragraph('Call <code>run()</code> and <em>then</em> wait for <a href="#">it</a>.')
  const before = p.innerHTML
  const block = blockOf(p)!
  const parsed = parseTranslation(
    '<g2>それ</g2>を<g1>そのあと</g1>待つ前に、<x0/>を呼ぶ。',
    block.map,
  )
  if ('error' in parsed) throw new Error(parsed.error)
  const originals = new Map()
  writeTranslation(block, parsed.kids, originals)

  restoreOriginals(originals)

  expect(p.innerHTML).toBe(before)
})

test('a translation that drops, repeats, adds or misnests a tag is refused', () => {
  const { p } = paragraph('Pass <code>a</code> to <b>the <i>b</i></b>.')
  const { map } = blockOf(p)!

  expect(parseTranslation('<g1>bに</g1>渡す。', map)).toEqual({ error: 'missing <x0/>' })
  expect(parseTranslation('<x0/>を<x0/>として<g1><g2>b</g2></g1>に渡す。', map)).toEqual({
    error: 'repeated <x0/>',
  })
  expect(parseTranslation('<x0/>を<g1><g2>b</g2></g1><g7>に</g7>渡す。', map)).toEqual({
    error: 'unknown <g7>',
  })
  expect(parseTranslation('<x0/>を<g1><g2>b</g1></g2>に渡す。', map)).toEqual({
    error: 'misnested </g1>',
  })
})

test('a lenient parse copies a repeated <xN/> and keeps the text of an unknown tag, but still refuses a missing one', () => {
  const { p } = paragraph('Only <code>App</code> may call <code>set</code>.')
  const block = blockOf(p)!
  const parsed = parseTranslation(
    '<x1/>を呼べるのは<g5>本当に</g5><x0/>だけで、<x0/>が持つ。',
    block.map,
    { lenient: true },
  )
  if ('error' in parsed) throw new Error(parsed.error)
  const originals = new Map()

  writeTranslation(block, parsed.kids, originals)

  expect(p.innerHTML).toBe(
    '<code>set</code>を呼べるのは本当に<code>App</code>だけで、<code>App</code>が持つ。',
  )
  restoreOriginals(originals)
  expect(p.innerHTML).toBe('Only <code>App</code> may call <code>set</code>.')
  expect(parseTranslation('呼べるのは<x0/>だけ。', block.map, { lenient: true })).toEqual({
    error: 'missing <x1/>',
  })
})

test('a child that the page took out after the translation was written does not come back with the original', () => {
  const { p } = paragraph('Call <code>run()</code> and <em>then</em> wait.')
  const block = blockOf(p)!
  const parsed = parseTranslation('<x0/>を呼び、<g1>そのあと</g1>待つ。', block.map)
  if ('error' in parsed) throw new Error(parsed.error)
  const originals = new Map()
  writeTranslation(block, parsed.kids, originals)
  p.querySelector('em')!.remove()

  restoreOriginals(originals)

  expect(p.innerHTML).toBe('Call <code>run()</code> and  wait.')
})

test('a text that the page rewrites after it was translated goes back to the rewritten original, not the first one', () => {
  const { p } = paragraph('Old article')
  const text = p.firstChild as Text
  const originals = new Map()
  const first = blockOf(p)!
  writeTranslation(first, ['古い記事'], originals)

  text.data = 'New article'
  writeTranslation(blockOf(p)!, ['新しい記事'], originals)
  restoreOriginals(originals)

  expect(p.innerHTML).toBe('New article')
})
