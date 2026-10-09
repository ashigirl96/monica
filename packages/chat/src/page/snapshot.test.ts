import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page, PageSnapshot } from '../contract.ts'
import { snapshotOf } from './snapshot.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

const ARTICLE: Page = {
  url: 'https://coast.example/tide-pools',
  title: 'Tide pools of the northern coast',
  content: { kind: 'html', html: fixture('article.html') },
}

async function textOf(page: Page): Promise<string> {
  const { content } = await snapshotOf(page, [])
  if (content?.kind !== 'text') throw new Error(`no text: ${JSON.stringify(content)}`)
  return content.text
}

test('a Markdown link keeps only its text, whatever its destination and title hold', async () => {
  const text = await textOf(ARTICLE)

  expect(text).toContain('Read the field guide before you go')
  expect(text).toContain('check the tide tables for the week, and')
  expect(text).toContain('see the notes on \\[bracketed\\] names for the local terms')
  expect(text).toContain('If you get stuck, call the ranger station before the tide turns')
  for (const leftover of ['guide_', 'tide%20tables', 'coast.example/notes', '555', 'Field guide']) {
    expect(text).not.toContain(leftover)
  }
})

// getHTML は shadow root を <template shadowrootmode> で書き出す。
test('the text inside open and closed declarative shadow roots stays in the text', async () => {
  const text = await textOf(ARTICLE)

  expect(text).toContain('SHADOW-OPEN-2208')
  expect(text).toContain('SHADOW-CLOSED-7351')
})

test('the nav and the footer stay out of the text', async () => {
  const text = await textOf(ARTICLE)

  expect(text).toContain('Tide pools form where the sea leaves water behind')
  expect(text).not.toContain('NAV-')
  expect(text).not.toContain('FOOTER-COPYRIGHT')
})

test('a page without text gives an empty text', async () => {
  const snapshot = await snapshotOf(
    { url: 'https://coast.example/empty', content: { kind: 'html', html: fixture('empty.html') } },
    [],
  )

  expect(snapshot.content).toEqual({ kind: 'text', source: 'html', text: '', truncated: false })
})

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the long report on the tides, the moon and the shape of the coastline, told again in more detail.</p>`

test('a text longer than 100,000 characters keeps its first 100,000 and is marked truncated', async () => {
  const paragraphs = Array.from({ length: 1500 }, (_, n) => paragraph(n)).join('\n')
  const { content } = await snapshotOf(
    {
      url: 'https://coast.example/report',
      content: { kind: 'html', html: `<body><article>${paragraphs}</article></body>` },
    },
    [],
  )

  if (content?.kind !== 'text') throw new Error('no text')
  expect(content.text).toHaveLength(100_000)
  expect(content.text.startsWith('Paragraph 0 of the long report')).toBe(true)
  expect(content.truncated).toBe(true)
})

test('a selection longer than 100,000 characters keeps its first 100,000 without splitting a surrogate pair', async () => {
  const selection = `a${'🌊'.repeat(60_000)}`

  const snapshot = await snapshotOf({ ...ARTICLE, selection }, [])

  expect(snapshot.selection).toEqual({ text: `a${'🌊'.repeat(49_999)}`, truncated: true })
  expect(snapshot.content).toMatchObject({ kind: 'text', truncated: false })
})

test('a selection within the limit goes as it is', async () => {
  const snapshot = await snapshotOf({ ...ARTICLE, selection: 'the splash zone' }, [])

  expect(snapshot.selection).toEqual({ text: 'the splash zone', truncated: false })
})

const turn = (page: PageSnapshot, n: number) => ({ question: `Q${n}?`, answer: `A${n}.`, page })
const textPage = (url: string, text: string): PageSnapshot => ({
  url,
  content: { kind: 'text', source: 'html', text, truncated: false },
})

test('a page whose URL, apart from the hash, and text match an earlier one points at the newest such turn instead of carrying the text', async () => {
  const first = await snapshotOf(ARTICLE, [])
  const history = [
    turn(first, 0),
    turn(textPage('https://other.example/', 'Other.'), 1),
    turn({ ...first, url: `${ARTICLE.url}#the-splash-zone` }, 2),
    turn({ ...first, content: { kind: 'same', turn: 2 } }, 3),
  ]

  const snapshot = await snapshotOf(
    { ...ARTICLE, url: `${ARTICLE.url}#the-low-zone`, selection: 'kelp crabs' },
    history,
  )

  expect(snapshot).toEqual({
    url: `${ARTICLE.url}#the-low-zone`,
    title: ARTICLE.title,
    selection: { text: 'kelp crabs', truncated: false },
    content: { kind: 'same', turn: 2 },
  })
})

test('a page at an earlier URL whose text changed carries its text', async () => {
  const first = await snapshotOf(ARTICLE, [])
  const changed = fixture('article.html').replace('Tide pools form', 'Rock pools form')

  const snapshot = await snapshotOf({ ...ARTICLE, content: { kind: 'html', html: changed } }, [
    turn(first, 0),
  ])

  expect(snapshot.content).toMatchObject({ kind: 'text' })
})

test('a page with the text of an earlier one at another URL carries its text', async () => {
  const first = await snapshotOf(ARTICLE, [])

  const snapshot = await snapshotOf({ ...ARTICLE, url: 'https://mirror.example/tide-pools' }, [
    turn(first, 0),
  ])

  expect(snapshot.content).toMatchObject({ kind: 'text' })
})

test('images are dropped, the source of a picture element too', async () => {
  const text = await textOf(ARTICLE)

  for (const leftover of ['IMAGE-ALT', 'anemone.jpg', 'kelp.webp', 'kelp.jpg', '![', '\n!\n']) {
    expect(text).not.toContain(leftover)
  }
})

// turndown は colspan のある表・sup・iframe・video・audio を生の HTML のまま残す。
test('raw HTML left in the Markdown loses the a tags and the iframe, video and audio elements, and keeps the other tags', async () => {
  const text = await textOf(ARTICLE)

  expect(text).toContain('<td>TABLE-LINK-periwinkle</td>')
  expect(text).toContain('<sup>[1]</sup>')
  expect(text).toContain('<th colspan="2">Animals by zone</th>')
  for (const leftover of [
    '<a',
    '</a>',
    'href',
    'video.example',
    'IFRAME-TITLE',
    'VIDEO-FALLBACK',
    'AUDIO-FALLBACK',
  ]) {
    expect(text).not.toContain(leftover)
  }
})
