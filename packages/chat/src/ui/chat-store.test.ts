import { expect, test } from 'bun:test'

import {
  type AskInput,
  type ChatEvent,
  MAX_ASK_BODY_BYTES,
  type Page,
  type PageSnapshot,
  type SnapshotEvent,
  type Unreadable,
} from '../contract.ts'
import { type ChatClient, createChatStore } from './chat-store.ts'

/** 答えの stream。signal に応えず、test が流した event をそのまま渡す。 */
class FakeAnswer implements AsyncIterable<ChatEvent> {
  readonly #queue: (IteratorResult<ChatEvent> | Error)[] = []
  #wake: (() => void) | undefined

  snapshot(page: PageSnapshot, omitted: SnapshotEvent['omitted'] = { pages: 0, turns: 0 }): void {
    this.#push({ done: false, value: { type: 'snapshot', page, omitted } })
  }
  text(text: string): void {
    this.#push({ done: false, value: { type: 'text', text } })
  }
  end(): void {
    this.#push({ done: true, value: undefined })
  }
  fail(): void {
    this.#push(new Error('claude exited'))
  }

  #push(item: IteratorResult<ChatEvent> | Error): void {
    this.#queue.push(item)
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatEvent> {
    for (;;) {
      const item = this.#queue.shift()
      if (!item) {
        await new Promise<void>((resolve) => (this.#wake = resolve))
        continue
      }
      if (item instanceof Error) throw item
      if (item.done) return
      yield item.value
    }
  }
}

class FakeClient implements ChatClient {
  prepared = 0
  prepareFails = false
  askFails = false
  readonly asked: { input: AskInput; signal: AbortSignal; answer: FakeAnswer }[] = []

  async prepare(): Promise<void> {
    this.prepared++
    if (this.prepareFails) throw new Error('Backend is not running')
  }

  async ask(
    input: AskInput,
    { signal }: { signal: AbortSignal },
  ): Promise<AsyncIterable<ChatEvent>> {
    if (this.askFails) throw new Error('Backend is not running')
    const answer = new FakeAnswer()
    this.asked.push({ input, signal, answer })
    return answer
  }
}

const settled = () => Bun.sleep(0)

const pageAt = (url: string, title: string, more: Partial<Page> = {}): Page => ({
  url,
  title,
  content: { kind: 'html', html: `<body><p>${title} text</p></body>` },
  ...more,
})

/** Backend が pageAt の HTML を本文にした Page Snapshot。 */
const snapshotAt = (url: string, title: string): PageSnapshot => ({
  url,
  title,
  content: { kind: 'text', source: 'html', text: `${title} text`, truncated: false },
})

function openChat() {
  const client = new FakeClient()
  let page = pageAt('https://a.example/', 'A')
  const pdfLimits: number[] = []
  const store = createChatStore(client)
  store.open(async (maxPdfBytes) => {
    pdfLimits.push(maxPdfBytes)
    return page
  })
  return {
    client,
    store,
    pdfLimits,
    showPage: (next: Page) => {
      page = next
    },
  }
}

test('a question carries the Current Page at the time it was sent and grows its answer from the deltas', async () => {
  const { client, store } = openChat()

  store.ask('What is this?')
  await settled()
  client.asked[0]!.answer.snapshot(snapshotAt('https://a.example/', 'A'))
  client.asked[0]!.answer.text('It is ')
  client.asked[0]!.answer.text('A.')
  await settled()

  expect(client.asked.map(({ input }) => input)).toEqual([
    { question: 'What is this?', page: pageAt('https://a.example/', 'A'), history: [] },
  ])
  expect(store.snapshot().entries).toEqual([
    { id: 0, question: 'What is this?', answer: 'It is A.', status: 'answering' },
  ])
})

// Backend が本文にした Page Snapshot を返したとおりに履歴へ入れる。
async function answerWith(client: FakeClient, text: string) {
  await settled()
  const { answer, input } = client.asked.at(-1)!
  answer.snapshot(snapshotAt(input.page.url!, input.page.title!))
  answer.text(text)
  answer.end()
  await settled()
}

test('history holds the answered questions oldest first, each with the Page Snapshot that the Backend sent back for it', async () => {
  const { client, store, showPage } = openChat()

  store.ask('First?')
  await answerWith(client, 'One.')
  showPage(pageAt('https://b.example/', 'B'))
  store.ask('Second?')
  await answerWith(client, 'Two.')
  showPage(pageAt('https://c.example/', 'C'))
  store.ask('Third?')
  await settled()

  expect(client.asked.at(-1)!.input).toEqual({
    question: 'Third?',
    page: pageAt('https://c.example/', 'C'),
    history: [
      { question: 'First?', page: snapshotAt('https://a.example/', 'A'), answer: 'One.' },
      { question: 'Second?', page: snapshotAt('https://b.example/', 'B'), answer: 'Two.' },
    ],
  })
  expect(store.snapshot().entries.map(({ status }) => status)).toEqual([
    'answered',
    'answered',
    'waiting',
  ])
})

test('an answer that came without a Page Snapshot keeps only the URL and title of its page in history', async () => {
  const { client, store } = openChat()

  store.ask('First?')
  await settled()
  client.asked[0]!.answer.text('One.')
  client.asked[0]!.answer.end()
  await settled()
  store.ask('Second?')
  await settled()

  expect(client.asked[1]!.input.history).toEqual([
    { question: 'First?', page: { url: 'https://a.example/', title: 'A' }, answer: 'One.' },
  ])
})

// body の上限を超えた request は 413 で失敗するので、今のページの中身だけを外して質問は届ける。
test('a question whose request would pass the body limit goes without the HTML and selection of its page, as too large to read', async () => {
  const { client, store, showPage } = openChat()
  const html = 'x'.repeat(MAX_ASK_BODY_BYTES - 512 * 1024)
  showPage(
    pageAt('https://big.example/', 'Big', { selection: 'x', content: { kind: 'html', html } }),
  )

  store.ask('What is this?')
  await settled()

  expect(client.asked[0]!.input.page).toEqual({
    url: 'https://big.example/',
    title: 'Big',
    content: { kind: 'unreadable', reason: 'too-large' },
  })
})

test('a question whose request stays 1MiB below the body limit goes with its HTML', async () => {
  const { client, store, showPage } = openChat()
  const html = 'x'.repeat(MAX_ASK_BODY_BYTES - 1024 * 1024 - 1024)
  showPage(pageAt('https://big.example/', 'Big', { content: { kind: 'html', html } }))

  store.ask('What is this?')
  await settled()

  expect(client.asked[0]!.input.page.content).toEqual({ kind: 'html', html })
})

const MARGIN = 1024 * 1024

test('a PDF may take what the body limit leaves after the question, the history and 1MiB', async () => {
  const { client, store, pdfLimits } = openChat()
  const answer = 'x'.repeat(10_000_000)

  store.ask('First?')
  await answerWith(client, answer)
  store.ask('Second?')
  await settled()

  const [first, second] = pdfLimits
  expect(first).toBeLessThanOrEqual(MAX_ASK_BODY_BYTES - MARGIN)
  expect(first).toBeGreaterThan(MAX_ASK_BODY_BYTES - MARGIN - 1024)
  expect(second).toBeLessThanOrEqual(MAX_ASK_BODY_BYTES - MARGIN - answer.length)
  expect(second).toBeGreaterThan(MAX_ASK_BODY_BYTES - MARGIN - answer.length - 1024)
})

const pdfOf = (bytes: number) => new File([new Uint8Array(bytes)], 'big.pdf')

test('a question whose PDF would take the request past the body limit goes without the PDF, as too large to read', async () => {
  const { client, store, showPage } = openChat()
  showPage(
    pageAt('https://big.example/a.pdf', 'Big', {
      content: { kind: 'pdf', pdf: pdfOf(MAX_ASK_BODY_BYTES - 512 * 1024) },
    }),
  )

  store.ask('What is this?')
  await settled()

  expect(client.asked[0]!.input.page).toEqual({
    url: 'https://big.example/a.pdf',
    title: 'Big',
    content: { kind: 'unreadable', reason: 'too-large' },
  })
})

test('a question whose PDF keeps the request 1MiB below the body limit goes with the PDF', async () => {
  const { client, store, showPage } = openChat()
  const pdf = pdfOf(MAX_ASK_BODY_BYTES - MARGIN - 1024)
  showPage(pageAt('https://big.example/a.pdf', 'Big', { content: { kind: 'pdf', pdf } }))

  store.ask('What is this?')
  await settled()

  expect(client.asked[0]!.input.page.content).toEqual({ kind: 'pdf', pdf })
})

async function noticeFor(page: PageSnapshot, omitted?: SnapshotEvent['omitted']) {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()
  client.asked[0]!.answer.snapshot(page, omitted)
  await settled()
  return store.snapshot().entries[0]!.notice
}

const readable = snapshotAt('https://a.example/', 'A')

test('a page read whole with nothing left out gives no notice', async () => {
  expect(await noticeFor(readable)).toBeUndefined()
  expect(await noticeFor({ ...readable, content: { kind: 'same', turn: 0 } })).toBeUndefined()
})

const unreadable = (reason: Unreadable['reason']) =>
  noticeFor({ ...readable, content: { kind: 'unreadable', reason } })

test('a page that could not be read gives a notice with the reason', async () => {
  expect(await unreadable('restricted')).toBe(
    'ページを読めませんでした（このページは Chrome Extension から読めません）',
  )
  expect(await unreadable('timeout')).toBe('ページを読めませんでした（3 秒以内に応えませんでした）')
  expect(await unreadable('too-large')).toBe('ページを読めませんでした（大きすぎます）')
  expect(await unreadable('fetch-failed')).toBe(
    'ページを読めませんでした（PDF を取得できませんでした）',
  )
  expect(await unreadable('unparsable')).toBe(
    'ページを読めませんでした（本文を取り出せませんでした）',
  )
})

test('a cut text or selection, and earlier pages or questions left out, join the notice in that order', async () => {
  const cut = {
    ...readable,
    content: { kind: 'text', source: 'html', text: 'A', truncated: true },
  } as const

  expect(await noticeFor(cut)).toBe('本文を切り詰めました')
  expect(
    await noticeFor(
      { ...readable, selection: { text: 'A', truncated: true } },
      { pages: 1, turns: 1 },
    ),
  ).toBe('選択範囲を切り詰めました。古いページや問答 2 件を渡していません')
  expect(
    await noticeFor(
      { ...readable, content: { kind: 'unreadable', reason: 'timeout' } },
      { pages: 2, turns: 0 },
    ),
  ).toBe(
    'ページを読めませんでした（3 秒以内に応えませんでした）。古いページや問答 2 件を渡していません',
  )
})

test('a question sent while an answer is coming is not sent', async () => {
  const { client, store } = openChat()

  store.ask('First?')
  await settled()
  client.asked[0]!.answer.text('On')
  await settled()
  const refused = store.ask('Second?')
  await settled()

  expect(refused).toBe(false)
  expect(client.asked).toHaveLength(1)
  expect(store.snapshot().entries.map(({ question }) => question)).toEqual(['First?'])
  expect(store.snapshot().answering).toBe(true)
})

test('a new Chat aborts the answer coming, empties the Chat and ignores the deltas that still arrive', async () => {
  const { client, store } = openChat()
  store.ask('First?')
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()
  const coming = client.asked[1]!
  coming.answer.text('Tw')
  await settled()

  store.startNewChat()
  coming.answer.text('o.')
  coming.answer.end()
  await settled()

  expect(coming.signal.aborted).toBe(true)
  expect(store.snapshot()).toEqual({ entries: [], answering: false })
})

test('the first question of a new Chat goes without the earlier questions, even one cut off mid-answer', async () => {
  const { client, store } = openChat()
  store.ask('First?')
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()

  store.startNewChat()
  const sent = store.ask('Again?')
  await settled()
  client.asked[1]!.answer.text('Two.')
  client.asked[1]!.answer.end()
  await settled()

  expect(sent).toBe(true)
  expect(client.asked[2]!.input.history).toEqual([])
  expect(store.snapshot().entries).toEqual([
    { id: 2, question: 'Again?', answer: '', status: 'waiting' },
  ])
})

test('a question whose answer broke off is marked failed and left out of the history', async () => {
  const { client, store } = openChat()
  store.ask('First?')
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()
  client.asked[1]!.answer.text('Tw')
  client.asked[1]!.answer.fail()
  await settled()

  store.ask('Third?')
  await settled()

  expect(store.snapshot().entries.map(({ status }) => status)).toEqual([
    'answered',
    'failed',
    'waiting',
  ])
  expect(client.asked[2]!.input.history.map(({ question }) => question)).toEqual(['First?'])
})

test('a question the Backend did not take is marked failed, and the next one can be sent', async () => {
  const { client, store } = openChat()
  client.askFails = true

  store.ask('First?')
  await settled()

  expect(store.snapshot()).toEqual({
    entries: [{ id: 0, question: 'First?', answer: '', status: 'failed' }],
    answering: false,
  })
  client.askFails = false
  expect(store.ask('Again?')).toBe(true)
  await settled()
  expect(client.asked.map(({ input }) => input.history)).toEqual([[]])
})

test('opening asks the Backend once for a spare claude, and a failure there does not stop a question', async () => {
  const client = new FakeClient()
  client.prepareFails = true

  const store = createChatStore(client)
  const before = client.prepared
  store.open(async () => ({ content: { kind: 'unreadable', reason: 'restricted' } }))
  await settled()
  const sent = store.ask('Hello?')
  await settled()

  expect([before, client.prepared]).toEqual([0, 1])
  expect(sent).toBe(true)
  expect(client.asked).toHaveLength(1)
})

test('subscribers hear each change of the Chat', async () => {
  const { client, store } = openChat()
  const heard: string[] = []
  store.subscribe(() =>
    heard.push(
      store
        .snapshot()
        .entries.map(({ status }) => status)
        .join(),
    ),
  )

  store.ask('First?')
  await answerWith(client, 'One.')
  store.startNewChat()

  expect(heard).toEqual(['waiting', 'answering', 'answered', ''])
})

test('a change of the Current Page mid-answer leaves the answer with the question it was asked about', async () => {
  const { client, store, showPage } = openChat()

  store.ask('What is this?')
  await settled()
  client.asked[0]!.answer.snapshot(snapshotAt('https://a.example/', 'A'))
  client.asked[0]!.answer.text('It is ')
  await settled()
  showPage(pageAt('https://b.example/', 'B'))
  client.asked[0]!.answer.text('A.')
  client.asked[0]!.answer.end()
  await settled()
  store.ask('And?')
  await settled()

  expect(store.snapshot().entries[0]).toEqual({
    id: 0,
    question: 'What is this?',
    answer: 'It is A.',
    status: 'answered',
  })
  expect(client.asked[1]!.input.history).toEqual([
    { question: 'What is this?', page: snapshotAt('https://a.example/', 'A'), answer: 'It is A.' },
  ])
})
