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
  reason: null,
  state: null,
  createdAt: new Date('2026-11-11T00:00:00Z'),
})

const permission = (id: number, state: 'pending' | 'allowed' | 'denied'): StudyMessage => ({
  ...row(id, 'permission', `docker ps ${id}`),
  state,
})

type FakeConversation = { id: string; endedAt: Date | null; summary: string | null }

class FakeClient implements ConversationClient {
  rows: StudyMessage[] = []
  /** 新しい順。rows は conversationId で振り分ける。 */
  conversationRows: FakeConversation[] = [{ id: CONVERSATION, endedAt: null, summary: null }]
  repos: string[] = []
  readonly ends: { id: string; reflect?: boolean }[] = []
  getError: unknown
  sendError: unknown
  readonly gets: number[] = []
  readonly sent: string[] = []
  readonly answers: { id: number; allow: boolean }[] = []
  readonly watches: { stream: FakeStream; signal: AbortSignal }[] = []

  readonly permission = {
    answer: async (input: { id: number; allow: boolean }) => {
      this.answers.push(input)
      return permission(input.id, input.allow ? 'allowed' : 'denied')
    },
  }

  readonly conversation = {
    end: async (input: { id: string; reflect?: boolean }) => {
      this.ends.push(input)
      return { conversationId: CONVERSATION }
    },
  }

  async get() {
    this.gets.push(this.watches.length)
    if (this.getError) throw this.getError
    return {
      id: ID,
      dir: `/home/studies/${ID}`,
      missionLine: 'Understand ky',
      firstMessage: 'learn ky',
      running: false,
      repos: this.repos,
      conversations: this.conversationRows.map((conversation) => ({
        ...conversation,
        startedAt: new Date(),
        messages: this.rows.filter((r) => r.conversationId === conversation.id),
      })),
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

test('a pending permission row becomes the prompt instead of a row, and the same id denied turns into a row', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'run docker ps')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: true, lastMessageId: 1, partialText: '' })
  await until(store, (s) => s.study !== undefined)

  stream.push({ type: 'message', message: permission(2, 'pending') })
  const asking = await until(store, (s) => s.permission !== null)
  expect(asking.permission).toEqual(permission(2, 'pending'))
  expect(texts(asking)).toEqual(['run docker ps'])

  stream.push({ type: 'message', message: permission(2, 'denied') })
  const answered = await until(store, (s) => s.permission === null)
  expect(answered.messages).toEqual([row(1, 'user', 'run docker ps'), permission(2, 'denied')])
})

test('with two pending permission rows the prompt is the one with the smaller id', async () => {
  const client = new FakeClient()
  client.rows = [permission(5, 'pending'), permission(3, 'pending')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: true, lastMessageId: 5, partialText: '' })

  expect((await until(store, (s) => s.permission !== null)).permission!.id).toBe(3)
})

test('answering sends the answer and puts the returned row in place of the prompt', async () => {
  const client = new FakeClient()
  client.rows = [permission(2, 'pending')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: true, lastMessageId: 2, partialText: '' })
  await until(store, (s) => s.permission !== null)

  await store.answer(2, true)

  expect(client.answers).toEqual([{ id: 2, allow: true }])
  expect(store.getSnapshot()).toMatchObject({
    permission: null,
    messages: [permission(2, 'allowed')],
  })
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

const inConversation = (message: StudyMessage, conversationId: string): StudyMessage => ({
  ...message,
  conversationId,
})

test('a reflection turn that ends the Study Conversation leaves an empty new conversation after turn-ended', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky'), row(2, 'tutor', 'why ky?')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 2, partialText: '' })
  await until(store, (s) => s.messages.length === 2)

  await store.end(true)
  expect(client.ends).toEqual([{ id: ID, reflect: true }])
  stream.push({ type: 'turn-started', conversationId: CONVERSATION })
  stream.push({ type: 'message', message: row(3, 'reflection', '') })
  stream.push({ type: 'message', message: row(4, 'tutor', 'Wrote LR-0001.') })
  const reflecting = await until(store, (s) => s.messages.length === 4)
  expect(reflecting).toMatchObject({ running: true, shown: { id: CONVERSATION } })

  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: 'Wrote LR-0001.' }]
  stream.push({ type: 'turn-ended', error: null })

  const ended = await until(store, (s) => !s.running && s.shown === null)
  expect(ended).toMatchObject({ messages: [], ongoingId: null })
  expect(ended.conversations).toEqual([
    {
      id: CONVERSATION,
      startedAt: expect.any(Date),
      endedAt: expect.any(Date),
      summary: 'Wrote LR-0001.',
    },
  ])
})

test('a Study without an ongoing Study Conversation opens on the newest ended one, and selecting another shows its rows', async () => {
  const client = new FakeClient()
  client.conversationRows = [
    { id: 'newer', endedAt: new Date(), summary: 'newer summary' },
    { id: 'older', endedAt: new Date(), summary: 'older summary' },
  ]
  client.rows = [
    inConversation(row(1, 'user', 'first'), 'older'),
    inConversation(row(2, 'user', 'second'), 'newer'),
  ]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 2, partialText: '' })

  const opened = await until(store, (s) => s.study !== undefined)
  expect(opened).toMatchObject({ ongoingId: null, shown: { id: 'newer' } })
  expect(texts(opened)).toEqual(['second'])

  store.select('older')
  expect(store.getSnapshot().shown).toMatchObject({ id: 'older', summary: 'older summary' })
  expect(texts(store.getSnapshot())).toEqual(['first'])
})

test('a send turn that ends the Study Conversation without reflecting keeps it shown with the sent row and the error', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky'), row(2, 'tutor', 'why ky?')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 2, partialText: '' })
  await until(store, (s) => s.messages.length === 2)

  await store.send('again')
  stream.push({ type: 'turn-started', conversationId: CONVERSATION })
  client.rows = [...client.rows, row(101, 'user', 'again')]
  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: 'no SDK record' }]
  stream.push({ type: 'turn-ended', error: 'No conversation found with session ID x' })

  const ended = await until(
    store,
    (s) => s.ongoingId === null && s.conversations[0]?.endedAt !== null,
  )
  expect(ended.shown).toMatchObject({ id: CONVERSATION, summary: 'no SDK record' })
  expect(texts(ended)).toEqual(['learn ky', 'why ky?', 'again'])
  expect(ended.turnError).toBe('No conversation found with session ID x')
})

test('the linked Repos come with the Study, and reload rereads them without a watch event', async () => {
  const client = new FakeClient()
  client.repos = ['acme/alpha']
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: null, partialText: '' })
  await until(store, (s) => s.study !== undefined)
  expect(store.getSnapshot().repos).toEqual(['acme/alpha'])

  client.repos = ['acme/alpha', 'acme/beta']
  await store.reload()

  expect(store.getSnapshot().repos).toEqual(['acme/alpha', 'acme/beta'])
})

test('ending without a reflection shows an empty new conversation once conversation.end returns', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky'), row(2, 'tutor', 'why ky?')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 2, partialText: '' })
  await until(store, (s) => s.messages.length === 2)

  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: null }]
  await store.end(false)

  expect(client.ends).toEqual([{ id: ID, reflect: false }])
  expect(store.getSnapshot()).toMatchObject({ shown: null, messages: [], ongoingId: null })
  expect(store.getSnapshot().conversations).toMatchObject([{ id: CONVERSATION, summary: null }])
})

test('canReflect is true only on the ongoing Study Conversation with a user row, no turn and no pending permission', async () => {
  const client = new FakeClient()
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: null, partialText: '' })
  const empty = await until(store, (s) => s.study !== undefined)
  expect(empty).toMatchObject({ shown: { id: CONVERSATION }, canReflect: false })

  stream.push({ type: 'message', message: row(1, 'tutor', 'Hi') })
  expect((await until(store, (s) => s.messages.length === 1)).canReflect).toBe(false)
  stream.push({ type: 'message', message: row(2, 'user', 'learn ky') })
  expect((await until(store, (s) => s.messages.length === 2)).canReflect).toBe(true)

  stream.push({ type: 'turn-started', conversationId: CONVERSATION })
  expect((await until(store, (s) => s.running)).canReflect).toBe(false)
  stream.push({ type: 'message', message: permission(3, 'pending') })
  expect((await until(store, (s) => s.permission !== null)).canReflect).toBe(false)
  stream.push({ type: 'message', message: permission(3, 'denied') })
  stream.push({ type: 'turn-ended', error: null })
  expect((await until(store, (s) => !s.running && s.permission === null)).canReflect).toBe(true)

  client.conversationRows = [
    { id: 'newer', endedAt: null, summary: null },
    { id: CONVERSATION, endedAt: new Date(), summary: 'Wrote LR-0001.' },
  ]
  await store.reload()
  store.select(CONVERSATION)
  expect(store.getSnapshot()).toMatchObject({ shown: { id: CONVERSATION }, canReflect: false })
})

test('conversation-ended from watch rereads the Study, so a conversation ended elsewhere stops being the ongoing one', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 1, partialText: '' })
  expect((await until(store, (s) => s.study !== undefined)).canReflect).toBe(true)

  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: null }]
  stream.push({ type: 'conversation-ended', conversationId: CONVERSATION })

  const ended = await until(store, (s) => s.ongoingId === null)
  expect(ended).toMatchObject({ shown: { id: CONVERSATION }, canReflect: false })
})

test('after ending without a reflection, a reread that still saw the conversation open is overtaken by the next one', async () => {
  const client = new FakeClient()
  client.rows = [row(1, 'user', 'learn ky')]
  const store = open(client)
  const stream = await watching(client)
  stream.push({ type: 'snapshot', running: false, lastMessageId: 1, partialText: '' })
  await until(store, (s) => s.study !== undefined)

  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: null }]
  await store.end(false)
  client.conversationRows = [{ id: CONVERSATION, endedAt: null, summary: null }]
  await store.reload()
  expect(store.getSnapshot().shown).toMatchObject({ id: CONVERSATION })
  client.conversationRows = [{ id: CONVERSATION, endedAt: new Date(), summary: null }]
  stream.push({ type: 'conversation-ended', conversationId: CONVERSATION })

  expect(await until(store, (s) => s.ongoingId === null)).toMatchObject({ shown: null })
})
