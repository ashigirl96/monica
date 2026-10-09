import { afterEach, expect, spyOn, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import {
  askErrors,
  type AskInput,
  type ChatEvent,
  MAX_ASK_BODY_BYTES,
  type Page,
  type PageSnapshot,
  type SnapshotEvent,
  type Unreadable,
} from '../contract.ts'
import { type ChatClient, createChatStore } from './chat-store.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

/** 答えの stream。signal に応えず、test が流した event をそのまま渡す。 */
class FakeAnswer implements AsyncIterable<ChatEvent> {
  readonly #queue: (IteratorResult<ChatEvent> | { error: unknown })[] = []
  #wake: (() => void) | undefined

  snapshot(page: PageSnapshot, omitted: SnapshotEvent['omitted'] = { pages: 0, turns: 0 }): void {
    this.#push({ done: false, value: { type: 'snapshot', page, omitted } })
  }
  text(text: string): void {
    this.#push({ done: false, value: { type: 'text', text } })
  }
  event(event: ChatEvent): void {
    this.#push({ done: false, value: event })
  }
  end(): void {
    this.#push({ done: true, value: undefined })
  }
  fail(error: unknown): void {
    this.#push({ error })
  }

  #push(item: IteratorResult<ChatEvent> | { error: unknown }): void {
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
      if ('error' in item) throw item.error
      if (item.done) return
      yield item.value
    }
  }
}

class FakeClient implements ChatClient {
  prepared = 0
  prepareError: unknown
  askError: unknown
  readonly asked: { input: AskInput; signal: AbortSignal; answer: FakeAnswer }[] = []

  async prepare(): Promise<void> {
    this.prepared++
    if (this.prepareError) throw this.prepareError
  }

  async ask(
    input: AskInput,
    { signal }: { signal: AbortSignal },
  ): Promise<AsyncIterable<ChatEvent>> {
    if (this.askError) throw this.askError
    const answer = new FakeAnswer()
    this.asked.push({ input, signal, answer })
    return answer
  }
}

// Chromium の fetch は、Backend の居ない port で TypeError: Failed to fetch を投げる。
const unreachable = () => new TypeError('Failed to fetch')

type Declared = keyof typeof askErrors

/** Backend が chat.ask の .errors() で宣言した error。RPCLink の client が受けるのと同じ形にする。 */
function declared(code: Declared, data?: unknown): ORPCError<string, unknown> {
  const { status, message } = askErrors[code]
  return new ORPCError(code, { status, message, data, defined: true })
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

const SHOT = 'c2NyZWVuc2hvdA=='

function openChat(client = new FakeClient()) {
  let page = pageAt('https://a.example/', 'A')
  let shot: Pick<Page, 'screenshot' | 'screenshotFailed'> = { screenshot: SHOT }
  const reads: { screenshot: boolean }[] = []
  const pdfLimits: number[] = []
  const focus = new EventTarget()
  const store = createChatStore(client)
  store.open(async ({ screenshot, maxPdfBytes }) => {
    reads.push({ screenshot })
    pdfLimits.push(maxPdfBytes)
    return screenshot ? { ...page, ...shot } : page
  }, focus)
  return {
    client,
    store,
    focus,
    reads,
    pdfLimits,
    showPage: (next: Page) => {
      page = next
    },
    failScreenshots: (reason: string) => {
      shot = { screenshotFailed: { reason } }
    },
  }
}

const latest = (client: FakeClient) => client.asked.at(-1)!

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
  const { answer, input } = latest(client)
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

  expect(latest(client).input).toEqual({
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

// 撮るのは送る操作の user gesture の中でなければ quota にかかるので、ask が返る前に読み始める。
test('only a question sent with the screenshot button pressed reads the page with a screenshot, starting before ask returns, and sending lifts the button', async () => {
  const { client, store, reads } = openChat()

  store.toggleScreenshot()
  const pressed = store.snapshot().withScreenshot
  store.ask('First?')
  const readsWhenAsked = [...reads]
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()

  expect(pressed).toBe(true)
  expect(readsWhenAsked).toEqual([{ screenshot: true }])
  expect(reads).toEqual([{ screenshot: true }, { screenshot: false }])
  expect(store.snapshot().withScreenshot).toBe(false)
  expect(client.asked.map(({ input }) => input.page.screenshot)).toEqual([SHOT, undefined])
})

test('pressing the screenshot button again lifts it', () => {
  const { store } = openChat()

  store.toggleScreenshot()
  store.toggleScreenshot()

  expect(store.snapshot().withScreenshot).toBe(false)
})

test('a question refused while an answer is coming keeps the screenshot button pressed', async () => {
  const { store, reads } = openChat()
  store.ask('First?')
  await settled()

  store.toggleScreenshot()
  store.ask('Second?')

  expect(reads).toEqual([{ screenshot: false }])
  expect(store.snapshot().withScreenshot).toBe(true)
})

test('the screenshot sent shows on the question and goes into history with the Page Snapshot that the Backend sent back, to go again with each later question', async () => {
  const { client, store, showPage } = openChat()

  store.toggleScreenshot()
  store.ask('First?')
  await answerWith(client, 'One.')
  showPage(pageAt('https://b.example/', 'B'))
  store.ask('Second?')
  await answerWith(client, 'Two.')
  store.ask('Third?')
  await settled()

  expect(store.snapshot().entries.map(({ screenshot }) => screenshot)).toEqual([
    SHOT,
    undefined,
    undefined,
  ])
  expect(client.asked.at(-1)!.input.history).toEqual([
    {
      question: 'First?',
      page: { ...snapshotAt('https://a.example/', 'A'), screenshot: SHOT },
      answer: 'One.',
    },
    { question: 'Second?', page: snapshotAt('https://b.example/', 'B'), answer: 'Two.' },
  ])
})

test('a new Chat lifts the screenshot button', () => {
  const { store } = openChat()

  store.toggleScreenshot()
  store.startNewChat()

  expect(store.snapshot().withScreenshot).toBe(false)
})

test('a question whose request would pass the body limit still goes with its screenshot', async () => {
  const { client, store, showPage } = openChat()
  const html = 'x'.repeat(MAX_ASK_BODY_BYTES - 512 * 1024)
  showPage(pageAt('https://big.example/', 'Big', { content: { kind: 'html', html } }))

  store.toggleScreenshot()
  store.ask('What is this?')
  await settled()

  expect(client.asked[0]!.input.page).toEqual({
    url: 'https://big.example/',
    title: 'Big',
    content: { kind: 'unreadable', reason: 'too-large' },
    screenshot: SHOT,
  })
})

test('an answer that came without a Page Snapshot keeps its screenshot in history with the URL and title of its page', async () => {
  const { client, store } = openChat()

  store.toggleScreenshot()
  store.ask('First?')
  await settled()
  client.asked[0]!.answer.text('One.')
  client.asked[0]!.answer.end()
  await settled()
  store.ask('Second?')
  await settled()

  expect(client.asked[1]!.input.history[0]!.page).toEqual({
    url: 'https://a.example/',
    title: 'A',
    screenshot: SHOT,
  })
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

test('a screenshot that could not be taken joins the notice after the page that could not be read', async () => {
  const failed = { reason: 'Cannot access contents of the page' }

  expect(await noticeFor({ ...readable, screenshotFailed: failed })).toBe(
    'スクリーンショットを撮れませんでした',
  )
  expect(
    await noticeFor(
      {
        ...readable,
        content: { kind: 'unreadable', reason: 'restricted' },
        screenshotFailed: failed,
      },
      { pages: 1, turns: 0 },
    ),
  ).toBe(
    'ページを読めませんでした（このページは Chrome Extension から読めません）。スクリーンショットを撮れませんでした。古いページや問答 1 件を渡していません',
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
  expect(store.snapshot()).toEqual({
    entries: [],
    answering: false,
    withScreenshot: false,
    unreachable: false,
    retryable: undefined,
  })
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

// ── 失敗 ────────────────────────────────────────────────────────────────

/** 1 つ目の質問を、text を流した後に error で終える。 */
async function failAfter(texts: ChatEvent[], error: unknown) {
  const chat = openChat()
  chat.store.ask('What is this?')
  await settled()
  const { answer } = chat.client.asked[0]!
  answer.snapshot(snapshotAt('https://a.example/', 'A'))
  for (const event of texts) answer.event(event)
  answer.fail(error)
  await settled()
  return { ...chat, entry: chat.store.snapshot().entries[0]! }
}

async function refusedWith(error: unknown) {
  const chat = openChat()
  chat.client.askError = error
  chat.store.ask('What is this?')
  await settled()
  return { ...chat, entry: chat.store.snapshot().entries[0]! }
}

const text = (t: string): ChatEvent => ({ type: 'text', text: t })

test('a question the Backend did not take shows that the desktop was not reached, and puts up the banner', async () => {
  const { store, entry } = await refusedWith(unreachable())

  expect(entry).toMatchObject({
    status: 'failed',
    answer: '',
    failure: { line: 'monica の desktop に届きませんでした' },
  })
  expect(entry.failure?.detail).toBeUndefined()
  expect(store.snapshot()).toMatchObject({ answering: false, unreachable: true, retryable: 0 })
})

test('an answer whose Backend went away keeps the answer so far, says it was cut off, and puts up the banner', async () => {
  const { store, entry } = await failAfter([text('Tw')], new TypeError('network error'))

  expect(entry).toMatchObject({
    status: 'failed',
    answer: 'Tw',
    failure: { line: '答えが途中で切れました' },
  })
  expect(store.snapshot()).toMatchObject({ unreachable: true, retryable: 0 })
})

test('a claude that is not logged in tells how to log in', async () => {
  const { entry } = await failAfter([], declared('NOT_AUTHENTICATED'))

  expect(entry.failure).toEqual({
    line: 'Claude Code に login していません。terminal で claude を起こし、/login してください',
  })
})

/** その日の時刻を local の時刻帯で作る。 */
function localTime(daysFromToday: number, hours: number, minutes: number): Date {
  const at = new Date()
  at.setDate(at.getDate() + daysFromToday)
  at.setHours(hours, minutes, 0, 0)
  return at
}

const unixSeconds = (at: Date) => at.getTime() / 1000

async function usageLimitLine(rateLimitType: string, resetsAt: Date) {
  const { entry } = await failAfter(
    [],
    declared('USAGE_LIMIT', { rateLimitType, resetsAt: unixSeconds(resetsAt) }),
  )
  return entry.failure
}

test('a plan limit names the limit and the time it resets, by the clock today or with the date on another day', async () => {
  const later = localTime(3, 16, 27)

  expect(await usageLimitLine('five_hour', localTime(0, 10, 0))).toEqual({
    line: 'plan の 5 時間の上限に達しました。10:00 に戻ります',
  })
  expect(await usageLimitLine('seven_day', later)).toEqual({
    line: `plan の週の上限に達しました。${later.getMonth() + 1}月${later.getDate()}日 16:27 に戻ります`,
  })
  expect((await usageLimitLine('seven_day_opus', localTime(0, 9, 5)))?.line).toBe(
    'plan の Opus の週の上限に達しました。9:05 に戻ります',
  )
  expect((await usageLimitLine('seven_day_sonnet', localTime(0, 9, 5)))?.line).toBe(
    'plan の Sonnet の週の上限に達しました。9:05 に戻ります',
  )
})

test('a plan limit of a kind the side panel does not know still reads as a plan limit', async () => {
  expect(await usageLimitLine('overage', localTime(0, 10, 0))).toEqual({
    line: 'plan の上限に達しました。10:00 に戻ります',
  })
})

test('a question refused because four claudes are answering says another Chat is answering', async () => {
  const { entry, store } = await refusedWith(declared('CHAT_BUSY'))

  expect(entry.failure).toEqual({ line: 'ほかの Chat が答えています' })
  expect(store.snapshot()).toMatchObject({ unreachable: false, retryable: 0 })
})

const failed = (detail: string) => declared('AGENT_FAILED', { detail })

test('a claude that failed mid-answer keeps the answer so far, says it was cut off, and gives what claude said', async () => {
  const { entry } = await failAfter([text('Tw')], failed('claude exited with code 1'))

  expect(entry).toMatchObject({
    status: 'failed',
    answer: 'Tw',
    failure: { line: '答えが途中で切れました', detail: 'claude exited with code 1' },
  })
})

test('a claude that ran out of retries says the Anthropic API was not reached', async () => {
  const { entry } = await failAfter(
    [text('Tw'), { type: 'retry', attempt: 1 }],
    failed('API Error: 529 Overloaded'),
  )

  expect(entry).toMatchObject({
    answer: '',
    failure: { line: 'Anthropic の API に繋がりませんでした', detail: 'API Error: 529 Overloaded' },
  })
})

test('a claude that gave no answer says so and gives what claude said', async () => {
  const { entry } = await failAfter([], failed('Claude Code native binary not found'))

  expect(entry.failure).toEqual({
    line: 'claude が答えを返せませんでした',
    detail: 'Claude Code native binary not found',
  })
})

test('an error the Backend did not declare says claude gave no answer, with its code and message', async () => {
  const { entry } = await failAfter(
    [],
    new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Internal server error' }),
  )

  expect(entry.failure).toEqual({
    line: 'claude が答えを返せませんでした',
    detail: 'INTERNAL_SERVER_ERROR: Internal server error',
  })
})

test('a retry of the API drops the answer so far for a line that counts the retries, and the next text starts the answer again', async () => {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()
  const { answer } = client.asked[0]!
  answer.text('Tw')
  answer.event({ type: 'retry', attempt: 2 })
  await settled()
  const retrying = store.snapshot().entries[0]

  answer.text('Two')
  await settled()

  expect(retrying).toMatchObject({
    status: 'answering',
    answer: '',
    retrying: 'Anthropic の API に繋がりません。再試行しています（2 回目）',
  })
  expect(store.snapshot().entries[0]).toEqual({
    id: 0,
    question: 'What is this?',
    answer: 'Two',
    status: 'answering',
  })
})

async function usageLine(event: Omit<Extract<ChatEvent, { type: 'usage' }>, 'type'>) {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()
  const { answer } = client.asked[0]!
  answer.text('Two.')
  answer.event({ type: 'usage', ...event })
  answer.end()
  await settled()
  return store.snapshot().entries[0]
}

test('an answer near the plan limit is answered and shows how much of the plan is used and when it resets', async () => {
  const later = localTime(1, 8, 0)

  expect(
    await usageLine({
      utilization: 0.914,
      rateLimitType: 'five_hour',
      resetsAt: unixSeconds(localTime(0, 10, 0)),
    }),
  ).toMatchObject({
    status: 'answered',
    answer: 'Two.',
    usage: 'plan の 5 時間の枠を 91% 使いました（10:00 に戻ります）',
  })
  expect(
    (
      await usageLine({
        utilization: 0.876,
        rateLimitType: 'seven_day',
        resetsAt: unixSeconds(later),
      })
    )?.usage,
  ).toBe(
    `plan の週の枠を 88% 使いました（${later.getMonth() + 1}月${later.getDate()}日 8:00 に戻ります）`,
  )
  expect((await usageLine({ utilization: 0.9, rateLimitType: 'overage' }))?.usage).toBe(
    'plan の枠を 90% 使いました',
  )
})

// ── 再試行と履歴 ────────────────────────────────────────────────────────

test('only the last question that failed can be retried, and retrying sends its input again without reading the page', async () => {
  const { client, store, reads, showPage } = openChat()
  store.ask('First?')
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()
  const sent = client.asked[1]!
  sent.answer.snapshot(snapshotAt('https://a.example/', 'A'))
  sent.answer.fail(failed('claude exited'))
  await settled()
  const readsBefore = reads.length
  showPage(pageAt('https://b.example/', 'B'))

  expect(store.snapshot().retryable).toBe(1)
  expect(store.retry()).toBe(true)
  await settled()

  expect(reads).toHaveLength(readsBefore)
  expect(latest(client).input).toBe(sent.input)
  expect(store.snapshot().entries[1]).toEqual({
    id: 1,
    question: 'Second?',
    answer: '',
    status: 'waiting',
  })
  expect(store.snapshot().retryable).toBeUndefined()
})

test('retrying a question sent with a screenshot sends that screenshot again without taking another, and the answer keeps it in the history', async () => {
  const { client, store, reads } = openChat()
  store.toggleScreenshot()
  store.ask('What is shown?')
  await settled()
  client.asked[0]!.answer.fail(failed('claude exited'))
  await settled()

  store.retry()
  await answerWith(client, 'A chart.')
  store.ask('And?')
  await settled()

  expect(reads).toEqual([{ screenshot: true }, { screenshot: false }])
  expect(client.asked[1]!.input.page.screenshot).toBe(SHOT)
  expect(store.snapshot().entries[0]).toMatchObject({ status: 'answered', screenshot: SHOT })
  expect(latest(client).input.history[0]!.page.screenshot).toBe(SHOT)
})

test('a retried question that is answered joins the history', async () => {
  const { client, store } = openChat()
  store.ask('First?')
  await settled()
  client.asked[0]!.answer.fail(failed('claude exited'))
  await settled()

  store.retry()
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()

  expect(latest(client).input.history).toEqual([
    { question: 'First?', page: snapshotAt('https://a.example/', 'A'), answer: 'One.' },
  ])
})

test('a question that failed after its Page Snapshot stays on the screen but not in the history of the next one, which can no longer retry it', async () => {
  const { client, store } = openChat()
  store.ask('First?')
  await answerWith(client, 'One.')
  store.ask('Second?')
  await settled()
  client.asked[1]!.answer.snapshot(snapshotAt('https://a.example/', 'A'))
  client.asked[1]!.answer.text('Tw')
  client.asked[1]!.answer.fail(failed('claude exited'))
  await settled()

  store.ask('Third?')
  await settled()

  expect(store.snapshot().entries.map(({ question, status }) => [question, status])).toEqual([
    ['First?', 'answered'],
    ['Second?', 'failed'],
    ['Third?', 'waiting'],
  ])
  expect(latest(client).input.history.map(({ question }) => question)).toEqual(['First?'])
  expect(store.snapshot().retryable).toBeUndefined()
  expect(store.retry()).toBe(false)
})

// ── 止める ────────────────────────────────────────────────────────────

test('stopping aborts the stream, draws nothing that arrives later, and marks the answer stopped', async () => {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()
  const { answer, signal } = client.asked[0]!
  answer.snapshot(snapshotAt('https://a.example/', 'A'))
  answer.text('It is ')
  await settled()

  store.stop()
  answer.text('A.')
  answer.end()
  await settled()

  expect(signal.aborted).toBe(true)
  expect(store.snapshot()).toEqual({
    entries: [{ id: 0, question: 'What is this?', answer: 'It is ', status: 'stopped' }],
    answering: false,
    withScreenshot: false,
    unreachable: false,
    retryable: undefined,
  })
})

test('a stopped question joins the history with its answer so far and a mark that the user stopped it', async () => {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()
  client.asked[0]!.answer.snapshot(snapshotAt('https://a.example/', 'A'))
  client.asked[0]!.answer.text('It is ')
  await settled()

  store.stop()
  store.ask('Go on')
  await settled()

  expect(latest(client).input.history).toEqual([
    {
      question: 'What is this?',
      page: snapshotAt('https://a.example/', 'A'),
      answer: 'It is \n\n（ユーザーが途中で止めた）',
    },
  ])
})

test('a question stopped before its Page Snapshot joins the history with only the URL and title of its page', async () => {
  const { client, store } = openChat()
  store.ask('What is this?')
  await settled()

  store.stop()
  store.ask('Go on')
  await settled()

  expect(latest(client).input.history).toEqual([
    {
      question: 'What is this?',
      page: { url: 'https://a.example/', title: 'A' },
      answer: '（ユーザーが途中で止めた）',
    },
  ])
})

// ── Backend の不在の帯 ──────────────────────────────────────────────────

function captureInterval() {
  const spy = spyOn(globalThis, 'setInterval')
  const clear = spyOn(globalThis, 'clearInterval')
  cleanups.push(() => {
    spy.mockRestore()
    clear.mockRestore()
  })
  return {
    tick: () => {
      const [callback, ms] = spy.mock.calls.at(-1)!
      expect(ms).toBe(5000)
      ;(callback as () => void)()
    },
    cleared: () => clear.mock.calls.length > 0,
  }
}

test('a Backend that does not answer when the side panel opens puts up the banner, and questions can still be sent', async () => {
  const client = new FakeClient()
  client.prepareError = unreachable()

  const { store } = openChat(client)
  await settled()
  const banner = store.snapshot().unreachable
  const sent = store.ask('Hello?')
  await settled()

  expect(banner).toBe(true)
  expect(sent).toBe(true)
  expect(client.asked).toHaveLength(1)
})

test('while the banner is up, the side panel asks the Backend again every five seconds and on focus, and stops once it answers', async () => {
  const interval = captureInterval()
  const client = new FakeClient()
  client.prepareError = unreachable()
  const { store, focus } = openChat(client)
  await settled()

  interval.tick()
  focus.dispatchEvent(new Event('focus'))
  await settled()
  const whileDown = client.prepared

  client.prepareError = undefined
  interval.tick()
  await settled()
  const answered = client.prepared
  focus.dispatchEvent(new Event('focus'))
  await settled()

  expect(whileDown).toBe(3)
  expect(store.snapshot().unreachable).toBe(false)
  expect(interval.cleared()).toBe(true)
  expect(client.prepared).toBe(answered)
})

test('a Backend that answers with an error has been reached and takes down the banner', async () => {
  const interval = captureInterval()
  const client = new FakeClient()
  client.prepareError = unreachable()
  const { store } = openChat(client)
  await settled()

  client.prepareError = new ORPCError('INTERNAL_SERVER_ERROR')
  interval.tick()
  await settled()

  expect(store.snapshot().unreachable).toBe(false)
})

test('a question that reaches the Backend takes down the banner', async () => {
  const client = new FakeClient()
  client.prepareError = unreachable()
  const { store } = openChat(client)
  await settled()

  store.ask('Hello?')
  await settled()

  expect(store.snapshot().unreachable).toBe(false)
})

test('opening asks the Backend once for a spare claude', async () => {
  const client = new FakeClient()

  const before = client.prepared
  openChat(client)
  await settled()

  expect([before, client.prepared]).toEqual([0, 1])
})
