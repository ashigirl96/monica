import { expect, test } from 'bun:test'

import { parseHTML } from 'linkedom'

import type { Segment } from '../../contract.ts'
import {
  createPageTranslator,
  type PageTranslationState,
  type SegmentsReply,
} from './translator.ts'

const LONG = 'The animals that live in tide pools survive heat, rain and the pounding of waves. '
const ARTICLE = `<h1>Tide pools</h1><p>${LONG.repeat(6)}</p><p>Pools form in <b>hollows</b> of rock.</p>`

// 原文の頭に「訳 」を付けた文を、印をそのままにして返す。
const japanese = (text: string) => `訳 ${text}`

function start(
  answer: (segments: Segment[]) => SegmentsReply | Promise<SegmentsReply> = (segments) => ({
    segments: segments.map(({ id, text }) => ({ id, text: japanese(text) })),
  }),
  article = ARTICLE,
) {
  const { document } = parseHTML(
    `<html><head><title>Tide pools</title></head><body><nav><a href="/">Home page</a></nav><main><article>${article}</article></main></body></html>`,
  )
  const sent: Segment[][] = []
  const states: PageTranslationState[] = []
  const waits: number[] = []
  const settled: (() => void)[] = []
  const translator = createPageTranslator({
    document,
    url: () => 'https://coast.example/pools',
    async translate(segments) {
      sent.push(segments)
      return answer(segments)
    },
    report(state) {
      states.push(state)
      if (state.kind !== 'translating') for (const done of settled.splice(0)) done()
    },
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  const article_ = document.querySelector('article')!
  return {
    document,
    article: article_,
    translator,
    sent,
    states,
    waits,
    // translating の後に、translated か failed か original が届くまで待つ。
    settle: () => new Promise<void>((resolve) => settled.push(resolve)),
  }
}

const texts = (sent: Segment[][]) => sent.flat().map(({ text }) => text)

test('toggling translates the main text in place and reports translating, then translated', async () => {
  const { translator, article, document, sent, states, settle } = start()
  const settled = settle()

  translator.toggle()
  await settled

  expect(texts(sent)).toEqual([
    'Tide pools',
    LONG.repeat(6).trim(),
    'Pools form in <g0>hollows</g0> of rock.',
  ])
  expect(article.querySelector('h1')!.textContent).toBe('訳 Tide pools')
  expect(article.querySelectorAll('p')[1]!.innerHTML).toBe(
    '訳 Pools form in <b>hollows</b> of rock.',
  )
  expect(document.querySelector('nav')!.textContent).toBe('Home page')
  expect(states).toEqual([{ kind: 'translating' }, { kind: 'translated' }])
})

test('toggling again shows the original and reports it', async () => {
  const { translator, article, states, settle } = start()
  const before = article.innerHTML
  const settled = settle()
  translator.toggle()
  await settled

  translator.toggle()

  expect(article.innerHTML).toBe(before)
  expect(states.at(-1)).toEqual({ kind: 'original' })
})

test('a translation that comes back after the original is shown again is not written', async () => {
  const { promise: answered, resolve: answer } = Promise.withResolvers<SegmentsReply>()
  const { translator, article, sent } = start(() => answered)
  const before = article.innerHTML
  translator.toggle()
  await Promise.resolve()

  translator.toggle()
  answer({ segments: sent[0]!.map(({ id, text }) => ({ id, text: japanese(text) })) })
  await Bun.sleep(0)

  expect(article.innerHTML).toBe(before)
})

test('the segments go in chunks of at most 1,000 characters, at most three at a time', async () => {
  const held: (() => void)[] = []
  const article = Array.from(
    { length: 12 },
    (_, i) => `<p>Paragraph ${i}: ${LONG.repeat(3)}</p>`,
  ).join('')
  const { translator, sent } = start(
    (segments) =>
      new Promise((resolve) =>
        held.push(() =>
          resolve({ segments: segments.map(({ id, text }) => ({ id, text: japanese(text) })) }),
        ),
      ),
    article,
  )

  translator.toggle()
  await Bun.sleep(0)

  expect(sent).toHaveLength(3)
  for (const chunk of sent)
    expect(chunk.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(1000)
  held.shift()!()
  await Bun.sleep(0)
  expect(sent).toHaveLength(4)
})

test('a segment whose tags do not match is sent once more alone and then written leniently', async () => {
  const { translator, article, sent, settle } = start((segments) => {
    return {
      segments: segments.map(({ id, text }) => ({
        id,
        // 1 回目の知らない印は断られ、送り直した 2 回目だけ外して文字を残す。
        text: text.includes('<g0>') ? '岩の<g0>くぼみ</g0>に<g9>できる</g9>。' : japanese(text),
      })),
    }
  })
  const settled = settle()

  translator.toggle()
  await settled

  expect(sent.at(-1)!.map(({ text }) => text)).toEqual(['Pools form in <g0>hollows</g0> of rock.'])
  expect(article.querySelectorAll('p')[1]!.innerHTML).toBe('岩の<b>くぼみ</b>にできる。')
})

test('a segment that still misses a tag after it is sent again stays in the original', async () => {
  const { translator, article, sent, settle } = start((segments) => ({
    segments: segments.map(({ id, text }) => ({
      id,
      text: text.includes('<g0>') ? '岩のくぼみにできる。' : japanese(text),
    })),
  }))
  const settled = settle()

  translator.toggle()
  await settled

  expect(sent).toHaveLength(2)
  expect(article.querySelectorAll('p')[1]!.innerHTML).toBe('Pools form in <b>hollows</b> of rock.')
})

test('a busy Backend gets the same chunk again after a second', async () => {
  let call = 0
  const { translator, sent, waits, settle } = start((segments) =>
    ++call === 1
      ? { busy: true }
      : { segments: segments.map(({ id, text }) => ({ id, text: japanese(text) })) },
  )
  const settled = settle()

  translator.toggle()
  await settled

  expect(waits).toContain(1000)
  expect(sent[1]).toEqual(sent[0]!)
})

test('a failed translation reports its reason and sends nothing more', async () => {
  const article = Array.from(
    { length: 12 },
    (_, i) => `<p>Paragraph ${i}: ${LONG.repeat(3)}</p>`,
  ).join('')
  const { translator, sent, states, settle } = start(
    () => ({ failed: 'the monica desktop is not running' }),
    article,
  )
  const settled = settle()

  translator.toggle()
  await settled
  await Bun.sleep(0)

  expect(states.at(-1)).toEqual({ kind: 'failed', reason: 'the monica desktop is not running' })
  expect(sent).toHaveLength(3)
})

test('a part of the page drawn again in the original is translated again from what was kept, without sending it', async () => {
  const { translator, article, sent, settle } = start()
  let settled = settle()
  translator.toggle()
  await settled
  const sentBefore = sent.length

  settled = settle()
  article.innerHTML = ARTICLE
  await settled

  expect(sent).toHaveLength(sentBefore)
  expect(article.querySelector('h1')!.textContent).toBe('訳 Tide pools')
})

test('text that appears after the page is translated is translated too', async () => {
  const { translator, article, document, sent, settle } = start()
  let settled = settle()
  translator.toggle()
  await settled

  settled = settle()
  const p = document.createElement('p')
  p.textContent = 'Sea stars eat the mussels that cling to the rock.'
  article.append(p)
  await settled

  expect(texts([sent.at(-1)!])).toEqual(['Sea stars eat the mussels that cling to the rock.'])
  expect(p.textContent).toBe('訳 Sea stars eat the mussels that cling to the rock.')
})

test('a segment given up after it was sent again is not sent once more when the page changes', async () => {
  const { translator, article, document, sent, settle } = start((segments) => ({
    segments: segments.map(({ id, text }) => ({
      id,
      text: text.includes('<g0>') ? '岩のくぼみにできる。' : japanese(text),
    })),
  }))
  let settled = settle()
  translator.toggle()
  await settled
  const sentBefore = sent.length

  settled = settle()
  article.append(document.createElement('hr'))
  await settled

  expect(sent).toHaveLength(sentBefore)
})

test('paragraphs with the same tags each keep their own translation when drawn again', async () => {
  const article =
    '<p>Pools hold <b>sea stars</b> at low tide.</p><p>Rocks hold <b>mussels</b> in the waves.</p>'
  const { translator, article: root, sent, settle } = start(undefined, article)
  let settled = settle()
  translator.toggle()
  await settled
  const sentBefore = sent.length

  settled = settle()
  root.innerHTML = article
  await settled

  expect(sent).toHaveLength(sentBefore)
  expect([...root.querySelectorAll('p')].map((p) => p.innerHTML)).toEqual([
    '訳 Pools hold <b>sea stars</b> at low tide.',
    '訳 Rocks hold <b>mussels</b> in the waves.',
  ])
})

test('a paragraph rewritten while its translation is on the way is sent again in its new words', async () => {
  const held: (() => void)[] = []
  const article = '<p>Sea stars eat the mussels that cling to the rock.</p>'
  const {
    translator,
    article: root,
    sent,
    settle,
  } = start(
    (segments) =>
      new Promise((resolve) =>
        held.push(() =>
          resolve({ segments: segments.map(({ id, text }) => ({ id, text: japanese(text) })) }),
        ),
      ),
    article,
  )
  translator.toggle()
  await Bun.sleep(0)
  const p = root.querySelector('p')!
  p.firstChild!.textContent = 'Crabs hide under the rocks when the tide goes out.'
  await Bun.sleep(0)

  const settled = settle()
  held.shift()!()
  await Bun.sleep(0)
  held.shift()?.()
  await settled

  expect(texts(sent)).toEqual([
    'Sea stars eat the mussels that cling to the rock.',
    'Crabs hide under the rocks when the tide goes out.',
  ])
  expect(p.textContent).toBe('訳 Crabs hide under the rocks when the tide goes out.')
})

test('a paragraph longer than the Backend takes is left out, and no chunk holds more segments than it takes', async () => {
  const long = `<p>${'Tide '.repeat(4100)}</p>`
  const items = `<ul>${'<li>Kelp</li>'.repeat(250)}</ul>`
  const { translator, sent, settle } = start(
    undefined,
    `${long}<p>Sea stars eat mussels.</p>${items}`,
  )
  const settled = settle()

  translator.toggle()
  await settled

  expect(texts(sent)).not.toContain('Tide '.repeat(4100).trim())
  expect(texts(sent)).toContain('Sea stars eat mussels.')
  expect(texts(sent).filter((text) => text === 'Kelp')).toHaveLength(250)
  for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(200)
})

test('an answer that cannot be written reports a failure instead of leaving the chunk in flight', async () => {
  const { translator, states, settle } = start(
    () => ({ segments: null }) as unknown as SegmentsReply,
  )
  const settled = settle()

  translator.toggle()
  await settled

  expect(states.at(-1)).toMatchObject({ kind: 'failed', reason: expect.any(String) })
})
