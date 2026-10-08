import { expect, test } from 'bun:test'

import type { AskInput, ChatEvent, Page } from '../contract.ts'
import { type ChatClient, createChatStore } from './chat-store.ts'

/** 答えの stream。signal に応えず、test が流した delta をそのまま渡す。 */
class FakeAnswer implements AsyncIterable<ChatEvent> {
  readonly #queue: (IteratorResult<ChatEvent> | Error)[] = []
  #wake: (() => void) | undefined

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

function openChat() {
  const client = new FakeClient()
  let page: Page = { url: 'https://a.example/', title: 'A' }
  const store = createChatStore(client)
  store.open(async () => page)
  return {
    client,
    store,
    showPage: (next: Page) => {
      page = next
    },
  }
}

test('a question carries the Current Page at the time it was sent and grows its answer from the deltas', async () => {
  const { client, store } = openChat()

  store.ask('What is this?')
  await settled()
  client.asked[0]!.answer.text('It is ')
  client.asked[0]!.answer.text('A.')
  await settled()

  expect(client.asked.map(({ input }) => input)).toEqual([
    { question: 'What is this?', page: { url: 'https://a.example/', title: 'A' }, history: [] },
  ])
  expect(store.snapshot().entries).toEqual([
    { id: 0, question: 'What is this?', answer: 'It is A.', status: 'answering' },
  ])
})

async function answerWith(client: FakeClient, text: string) {
  await settled()
  const { answer } = client.asked.at(-1)!
  answer.text(text)
  answer.end()
  await settled()
}

test('history holds the answered questions oldest first, each with the page it was asked about', async () => {
  const { client, store, showPage } = openChat()

  store.ask('First?')
  await answerWith(client, 'One.')
  showPage({ url: 'https://b.example/', title: 'B' })
  store.ask('Second?')
  await answerWith(client, 'Two.')
  showPage({ url: 'https://c.example/', title: 'C' })
  store.ask('Third?')
  await settled()

  expect(client.asked.at(-1)!.input).toEqual({
    question: 'Third?',
    page: { url: 'https://c.example/', title: 'C' },
    history: [
      { question: 'First?', page: { url: 'https://a.example/', title: 'A' }, answer: 'One.' },
      { question: 'Second?', page: { url: 'https://b.example/', title: 'B' }, answer: 'Two.' },
    ],
  })
  expect(store.snapshot().entries.map(({ status }) => status)).toEqual([
    'answered',
    'answered',
    'waiting',
  ])
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
  store.open(async () => ({}))
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
  client.asked[0]!.answer.text('It is ')
  await settled()
  showPage({ url: 'https://b.example/', title: 'B' })
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
    {
      question: 'What is this?',
      page: { url: 'https://a.example/', title: 'A' },
      answer: 'It is A.',
    },
  ])
})
