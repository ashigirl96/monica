import { afterEach, expect, spyOn, test } from 'bun:test'

import { AsyncIteratorClass, ORPCError } from '@orpc/client'

import type { StudyMessage, StudyWatchEvent } from '../contract.ts'
import {
  type ConversationClient,
  type ConversationSnapshot,
  type ConversationStore,
  createConversationStore,
} from './conversation-store.ts'

const ID = 'study-0190a000-0000-7000-8000-000000000001'
const CONVERSATION = 'conversation-1'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

/** watch の stream。signal に応えず、test が流した event をそのまま渡す。 */
class FakeStream {
  readonly #queue: ({ event: StudyWatchEvent } | { error: unknown })[] = []
  #wake: (() => void) | undefined

  push(event: StudyWatchEvent): void {
    this.#queue.push({ event })
    this.#wake?.()
  }
  fail(error: unknown): void {
    this.#queue.push({ error })
    this.#wake?.()
  }

  async *events(): AsyncGenerator<StudyWatchEvent> {
    for (;;) {
      const item = this.#queue.shift()
      if (!item) {
        await new Promise<void>((resolve) => (this.#wake = resolve))
        continue
      }
      if ('error' in item) throw item.error
      yield item.event
    }
  }
}

const row = (id: number, kind: StudyMessage['kind'], text: string): StudyMessage => ({
  id,
  conversationId: CONVERSATION,
  kind,
  text,
  tool: null,
  createdAt: new Date('2026-11-11T00:00:00Z'),
})

class FakeClient implements ConversationClient {
  rows: StudyMessage[] = []
  getError: unknown
  sendError: unknown
  readonly gets: number[] = []
  readonly sent: string[] = []
  readonly watches: { stream: FakeStream; signal: AbortSignal }[] = []

  async get() {
    this.gets.push(this.watches.length)
    if (this.getError) throw this.getError
    return {
      id: ID,
      dir: `/home/studies/${ID}`,
      missionLine: 'Understand ky',
      firstMessage: 'learn ky',
      running: false,
      repos: [],
      conversations: [
        { id: CONVERSATION, startedAt: new Date(), endedAt: null, messages: [...this.rows] },
      ],
    }
  }

  async send({ text }: { id: string; text: string }) {
    if (this.sendError) throw this.sendError
    this.sent.push(text)
    return { message: row(100 + this.sent.length, 'user', text) }
  }

  async watch(_input: { id: string }, options?: { signal?: AbortSignal }) {
    const stream = new FakeStream()
    this.watches.push({ stream, signal: options!.signal! })
    const events = stream.events()
    // RPCLink の client と同じく、oRPC の event iterator で返す。
    return new AsyncIteratorClass(
      () => events.next(),
      async () => {
        await events.return(undefined)
      },
    )
  }
}

function open(client: FakeClient, onTurnEnded?: () => void): ConversationStore {
  const store = createConversationStore(client, ID, onTurnEnded)
  cleanups.push(store.open())
  return store
}

function until(
  store: ConversationStore,
  pass: (snapshot: ConversationSnapshot) => boolean,
): Promise<ConversationSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      if (!pass(store.getSnapshot())) return
      off()
      resolve(store.getSnapshot())
    }
    const off = store.subscribe(check)
    check()
  })
}

async function watching(client: FakeClient, count = 1) {
  while (client.watches.length < count) await Bun.sleep(0)
  return client.watches[count - 1]!.stream
}

const texts = (snapshot: ConversationSnapshot) => snapshot.messages.map((m) => m.text)

test('get is read after the snapshot, and rows from the stream overlay it by id without doubling', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky'), row(2, 'tutor', 'why ky?')]
  const store = open(client)
  const stream = await watching(client)
  await Bun.sleep(0)
  expect(client.gets).toEqual([])

  stream.push({ type: 'snapshot', running: false, lastMessageId: 1, partialText: '' })
  stream.push({ type: 'message', message: row(2, 'tutor', 'why ky?') })
  stream.push({ type: 'message', message: row(3, 'user', 'for work') })

  const snapshot = await until(store, (s) => s.messages.length === 3)
  expect(texts(snapshot)).toEqual(['learn ky', 'why ky?', 'for work'])
  expect(snapshot.study).toEqual({
    dir: `/home/studies/${ID}`,
    missionLine: 'Understand ky',
    firstMessage: 'learn ky',
  })
})

test('the partial Tutor text starts from the snapshot, grows by delta, and goes with the tutor row and the turn end', async () => {
  const client = new FakeClient()
  const store = open(client)
  const stream = await watching(client)

  stream.push({ type: 'snapshot', running: true, lastMessageId: null, partialText: 'Hel' })
  stream.push({ type: 'delta', text: 'lo' })
  expect(await until(store, (s) => s.partialText === 'Hello')).toMatchObject({ running: true })

  stream.push({ type: 'message', message: row(1, 'tutor', 'Hello') })
  await until(store, (s) => s.partialText === '' && s.messages.length === 1)

  stream.push({ type: 'delta', text: 'More' })
  await until(store, (s) => s.partialText === 'More')
  stream.push({ type: 'turn-ended', error: null })
  expect(await until(store, (s) => !s.running)).toMatchObject({ partialText: '' })
})

test('a failed turn leaves its error as the last line, rereads the Study, and the next send clears it', async () => {
  const client = new FakeClient()
  const ended = Promise.withResolvers<void>()
  const store = open(client, ended.resolve)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: null, partialText: '' })
  await until(store, (s) => s.study !== undefined)

  stream.push({ type: 'turn-started', conversationId: CONVERSATION })
  await until(store, (s) => s.running)
  stream.push({ type: 'turn-ended', error: 'claude exited' })

  expect(await until(store, (s) => s.turnError !== null)).toMatchObject({
    turnError: 'claude exited',
    running: false,
  })
  await ended.promise
  expect(client.gets).toHaveLength(2)

  expect(await store.send('again')).toBe(true)
  expect(store.getSnapshot().turnError).toBeNull()
  expect(texts(store.getSnapshot())).toEqual(['again'])
})

test('send is refused while a turn runs, and a failed send shows one line', async () => {
  const client = new FakeClient()
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: true, lastMessageId: null, partialText: '' })
  await until(store, (s) => s.study !== undefined)

  expect(await store.send('too early')).toBe(false)
  expect(client.sent).toEqual([])

  stream.push({ type: 'turn-ended', error: null })
  await until(store, (s) => !s.running)
  client.sendError = new ORPCError('CONFLICT', { message: 'a turn is already running' })
  expect(await store.send('again')).toBe(false)
  expect(store.getSnapshot().sendError).toBe('Tutor がまだ答えている。答え終わってから送る')
})

test('a broken stream reopens after a second, and closing aborts the stream', async () => {
  const timeout = spyOn(globalThis, 'setTimeout')
  cleanups.push(() => timeout.mockRestore())
  const client = new FakeClient()
  const store = createConversationStore(client, ID)
  const close = store.open()
  const first = await watching(client)
  first.push({ type: 'snapshot', running: false, lastMessageId: null, partialText: '' })
  await until(store, (s) => s.study !== undefined)

  first.fail(new TypeError('Failed to fetch'))
  while (!timeout.mock.calls.some(([, ms]) => ms === 1000)) await Bun.sleep(0)
  expect(client.watches).toHaveLength(1)
  const [retry] = timeout.mock.calls.find(([, ms]) => ms === 1000)!
  ;(retry as () => void)()

  await watching(client, 2)
  close()
  expect(client.watches[1]!.signal.aborted).toBe(true)
})

test('a Study the Backend does not know is missing and is not reopened', async () => {
  const client = new FakeClient()
  client.getError = new ORPCError('NOT_FOUND', { message: `no Study ${ID}` })
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: null, partialText: '' })

  await until(store, (s) => s.missing)
  await Bun.sleep(5)
  expect(client.watches).toHaveLength(1)
})

const toolRow = (id: number, tool: string, text: string): StudyMessage => ({
  ...row(id, 'tool', text),
  tool,
})

test('a Write or Edit row from watch in the Study dir asks to reread that artifact by its relative path, and other rows do not', async () => {
  const client = new FakeClient()
  const dir = `/home/studies/${ID}`
  client.rows = [toolRow(1, 'Write', `${dir}/MISSION.md`)]
  const written: string[] = []
  const store = createConversationStore(client, ID, undefined, (path) => written.push(path))
  cleanups.push(store.open())
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: true, lastMessageId: 1, partialText: '' })

  stream.push({ type: 'message', message: toolRow(2, 'Edit', '/home/learning-preference/x.md') })
  stream.push({ type: 'message', message: toolRow(3, 'Read', `${dir}/GLOSSARY.md`) })
  stream.push({
    type: 'message',
    message: toolRow(4, 'Write', `${dir}/learning-records/0001-x.md`),
  })
  stream.push({ type: 'message', message: toolRow(5, 'Edit', `${dir}/log.md`) })

  await until(store, (s) => s.messages.length === 5)
  expect(written).toEqual(['learning-records/0001-x.md', 'log.md'])
})
