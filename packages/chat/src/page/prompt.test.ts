import { expect, test } from 'bun:test'

import type { PageSnapshot, Turn } from '../contract.ts'
import { askContent } from './prompt.ts'

const page = (text: string, more: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'https://coast.example/tide-pools',
  title: 'Tide pools',
  content: { kind: 'text', text, truncated: false },
  ...more,
})

const documents = (content: ReturnType<typeof askContent>['content']) =>
  content.filter((block) => block.type === 'document')
const texts = (content: ReturnType<typeof askContent>['content']) =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : []))

test('the text of the page goes as a document titled with the page title and with its URL as context, before the question', () => {
  const { content } = askContent('What lives in the low zone?', page('Anemones live there.'), [])

  expect(content).toEqual([
    {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'Anemones live there.' },
      title: 'Tide pools',
      context: 'URL: https://coast.example/tide-pools',
    },
    { type: 'text', text: expect.stringContaining('What lives in the low zone?') },
  ])
})

// API は document の title を 1〜500 字とする。
test('the document title is the first 500 characters of the page title, and is left out for a page without a title', () => {
  const [long] = documents(askContent('Q?', page('Text.', { title: 'T'.repeat(600) }), []).content)
  const [untitled] = documents(askContent('Q?', page('Text.', { title: undefined }), []).content)

  expect(long).toMatchObject({ title: 'T'.repeat(500) })
  expect(untitled).not.toHaveProperty('title')
  expect(untitled).toMatchObject({ context: 'URL: https://coast.example/tide-pools' })
})

test('the context of a cut text says that only the first 100,000 characters are there', () => {
  const cutPage = page('Text.', { content: { kind: 'text', text: 'Text.', truncated: true } })

  const [document] = documents(askContent('Q?', cutPage, []).content)

  expect(document).toMatchObject({
    context: 'URL: https://coast.example/tide-pools\nOnly the first 100,000 characters of it.',
  })
})

const turn = (n: number, snapshot: PageSnapshot, answer = `Answer ${n}.`): Turn => ({
  question: `Question text ${n}?`,
  answer,
  page: snapshot,
})

test('earlier turns come oldest first with their documents, question and answer, and an answer never goes in a document', () => {
  const history = [
    turn(1, page('Page one.', { url: 'https://one.example/' })),
    turn(2, page('Page two.', { url: 'https://two.example/' })),
  ]

  const { content } = askContent('Question text 3?', page('Page three.'), history)

  expect(
    content.map((block) =>
      block.type === 'document' ? block.source : block.type === 'text' && block.text,
    ),
  ).toEqual([
    expect.objectContaining({ data: 'Page one.' }),
    expect.stringMatching(/^Question 1,[\s\S]*https:\/\/one\.example\/[\s\S]*Question text 1\?/),
    expect.stringContaining('Answer 1.'),
    expect.objectContaining({ data: 'Page two.' }),
    expect.stringMatching(/^Question 2,[\s\S]*https:\/\/two\.example\/[\s\S]*Question text 2\?/),
    expect.stringContaining('Answer 2.'),
    expect.objectContaining({ data: 'Page three.' }),
    expect.stringMatching(/^Question 3,[\s\S]*Question text 3\?/),
  ])
})

// 前の部分が prompt cache に乗るように、何も落とさなければ並びは前の質問の並びをそのまま頭に持つ。
test('when nothing is left out, the blocks of question n are the head of the blocks of question n+1', () => {
  const first = page('Anemones live there.', { selection: { text: 'Anemones', truncated: false } })
  const second: PageSnapshot = { ...first, content: { kind: 'same', turn: 0 } }
  const third = page('', {
    url: 'chrome://version',
    content: { kind: 'unreadable', reason: 'restricted' },
  })

  const one = askContent('Question text 1?', first, []).content
  const two = askContent('Question text 2?', second, [turn(1, first)]).content
  const three = askContent('Question text 3?', third, [turn(1, first), turn(2, second)]).content

  expect(two.slice(0, one.length)).toEqual(one)
  expect(three.slice(0, two.length)).toEqual(two)
  expect(two.length).toBeGreaterThan(one.length)
  expect(three.length).toBeGreaterThan(two.length)
})

const chars = (n: number, letter: string) => letter.repeat(n)
const dataOf = (content: ReturnType<typeof askContent>['content']) =>
  documents(content).map((block) => (block.source.type === 'text' ? block.source.data[0] : ''))

test('a Chat within 200,000 characters goes whole', () => {
  const history = [turn(1, page(chars(90_000, 'a'))), turn(2, page(chars(90_000, 'b')))]

  const { content, omitted } = askContent('Q?', page(chars(19_000, 'c')), history)

  expect(omitted).toEqual({ pages: 0, turns: 0 })
  expect(dataOf(content)).toEqual(['a', 'b', 'c'])
})

test('over 200,000 characters, the pages of the oldest turns go first, and their headings say so', () => {
  const history = [
    turn(1, page(chars(80_000, 'a'))),
    turn(2, page(chars(80_000, 'b'))),
    turn(3, page(chars(80_000, 'c'))),
  ]

  const { content, omitted } = askContent('Q?', page(chars(30_000, 'd')), history)

  expect(omitted).toEqual({ pages: 1, turns: 0 })
  expect(dataOf(content)).toEqual(['b', 'c', 'd'])
  expect(texts(content)[0]).toContain('The text of the page is left out')
  expect(texts(content)[0]).toContain('Question text 1?')
})

test('the page that the current page is the same as stays, and the current page stays', () => {
  const history = [
    turn(1, page(chars(80_000, 'a'))),
    turn(2, page(chars(80_000, 'b'))),
    turn(3, page(chars(80_000, 'c'))),
  ]
  const same = page('', {
    content: { kind: 'same', turn: 0 },
    selection: { text: chars(30_000, 's'), truncated: false },
  })

  const { content, omitted } = askContent('Q?', same, history)

  expect(omitted).toEqual({ pages: 1, turns: 0 })
  expect(dataOf(content)).toEqual(['a', 'c', 's'])
})

test('when leaving out every earlier page is not enough, the oldest questions and answers go too, and the message opens by saying how many', () => {
  const history = [
    turn(1, page('a'), chars(90_000, 'x')),
    turn(2, page('b'), chars(90_000, 'y')),
    turn(3, page('c'), chars(90_000, 'z')),
  ]

  const { content, omitted } = askContent('Q?', page(chars(30_000, 'd')), history)

  // 問答ごと落とした turn のページは pages に数えない。
  expect(omitted).toEqual({ pages: 1, turns: 2 })
  expect(dataOf(content)).toEqual(['d'])
  const all = texts(content).join('\n')
  expect(texts(content)[0]).toContain(
    '2 earlier questions of this chat and their answers are left out',
  )
  expect(all).not.toContain('Question text 1?')
  expect(all).not.toContain('Question text 2?')
  expect(all).toContain('Question text 3?')
  expect(all).toContain('zzz')
})

test('the turn that the current page is the same as keeps its question and answer when earlier questions go', () => {
  const history = [
    turn(1, page('a'), chars(90_000, 'x')),
    turn(2, page('b'), chars(90_000, 'y')),
    turn(3, page('c'), chars(90_000, 'z')),
  ]
  const same = page('', { content: { kind: 'same', turn: 0 } })

  const { content, omitted } = askContent('Q?', same, history)

  expect(omitted).toEqual({ pages: 1, turns: 1 })
  const all = texts(content).join('\n')
  expect(texts(content)[0]).toContain('1 earlier question of this chat and its answer is left out')
  expect(dataOf(content)).toEqual(['a'])
  expect(all).toContain('Question text 1?')
  expect(all).not.toContain('Question text 2?')
})

test('the current question and page go whole even when they alone pass 200,000 characters', () => {
  const big = page(chars(100_000, 'p'), {
    selection: { text: chars(100_000, 's'), truncated: false },
  })

  const { content, omitted } = askContent(chars(10_000, 'q'), big, [])

  expect(omitted).toEqual({ pages: 0, turns: 0 })
  expect(dataOf(content)).toEqual(['p', 's'])
})

test('a page that could not be read has no document, and its heading gives the reason with the URL and title', () => {
  const unreadable = page('', {
    content: { kind: 'unreadable', reason: 'timeout', detail: 'no reply' },
  })

  const { content } = askContent('Q?', unreadable, [])

  expect(documents(content)).toEqual([])
  expect(texts(content).join('\n')).toContain('did not respond within 3 seconds')
  expect(texts(content).join('\n')).toContain('https://coast.example/tide-pools')
  expect(texts(content).join('\n')).toContain('Tide pools')
})

// document の source.data に空の文字列を入れない。
test('a page without text has no document, and its heading says it had no text', () => {
  const { content } = askContent('Q?', page(''), [])

  expect(documents(content)).toEqual([])
  expect(texts(content).join('\n')).toContain('The page had no text.')
})

test('a page the same as an earlier one has no document of its text, and its heading names that question', () => {
  const history = [{ question: 'Q1?', answer: 'A1.', page: page('Anemones live there.') }]
  const same = page('', {
    content: { kind: 'same', turn: 0 },
    selection: { text: 'kelp', truncated: false },
  })

  const { content } = askContent('Q2?', same, history)

  expect(documents(content).map((block) => block.source)).toEqual([
    expect.objectContaining({ data: 'Anemones live there.' }),
    expect.objectContaining({ data: 'kelp' }),
  ])
  expect(texts(content).at(-1)).toContain('the same text as on the page of question 1')
})

test('the selection goes as a document of its own after the text, titled as a selection of the page', () => {
  const selected = page('The whole article.', {
    selection: { text: 'Anemones', truncated: true },
  })

  const { content } = askContent('What are these?', selected, [])

  expect(documents(content)).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ data: 'The whole article.' }) }),
    {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'Anemones' },
      title: 'Selection: Tide pools',
      context: 'URL: https://coast.example/tide-pools\nOnly the first 100,000 characters of it.',
    },
  ])
  expect(texts(content).join('\n')).not.toContain('Anemones')
})
