import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import type { AskUser } from './box.ts'
import type { TurnEnd, TutorClaudes, TutorEvent, TutorRequest } from './claude.ts'
import { createRunner } from './cleanup.ts'
import {
  createStudyLifecycle,
  decide,
  endingAfter,
  isRefusal,
  type Occupancy,
  recordOf,
  type Turn,
  type Want,
} from './lifecycle.ts'
import { study, studyMessage } from './schema.ts'
import { inMemoryDb, until } from './study-fixture.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const turn: Turn = {
  mode: 'say',
  partialText: '',
  running: true,
  ended: Promise.resolve(),
  end: () => {},
}
const states: Record<string, Occupancy | undefined> = {
  idle: undefined,
  turn: { kind: 'turn', turn },
  closing: { kind: 'closing', turn, done: Promise.resolve() },
  cleaning: { kind: 'cleaning', done: Promise.resolve() },
  removing: { kind: 'removing', prior: { kind: 'turn', turn } },
}

test.each([
  ['idle', 'send', false, 'go'],
  ['idle', 'reflect', false, 'go'],
  ['idle', 'clean', false, 'go'],
  ['turn', 'send', false, 'turn-running'],
  ['turn', 'reflect', false, 'turn-running'],
  ['turn', 'leave', false, 'turn-running'],
  ['turn', 'reflect', true, { interrupt: turn }],
  ['turn', 'leave', true, { interrupt: turn }],
  ['turn', 'shell', false, 'go'],
  ['turn', 'clean', false, 'turn-running'],
  ['turn', 'remove', false, 'go'],
  ['closing', 'send', false, 'conversation-ending'],
  ['closing', 'leave', true, 'conversation-ending'],
  ['closing', 'shell', false, 'go'],
  ['closing', 'clean', false, 'conversation-ending'],
  ['closing', 'remove', false, 'go'],
  ['cleaning', 'send', false, 'playground-cleaning'],
  ['cleaning', 'reflect', false, 'playground-cleaning'],
  ['cleaning', 'leave', false, 'go'],
  ['cleaning', 'shell', false, 'playground-cleaning'],
  ['cleaning', 'clean', false, 'playground-cleaning'],
  ['cleaning', 'remove', false, 'go'],
  ['removing', 'send', false, 'study-removing'],
  ['removing', 'leave', true, 'study-removing'],
  ['removing', 'shell', false, 'study-removing'],
  ['removing', 'clean', false, 'study-removing'],
  ['removing', 'remove', false, 'study-removing'],
] as const)(
  'a Study in %s answers %s (permission pending: %p) with %p',
  (state, want: Want, pending, verdict) => {
    const occupancy = states[state]
    expect(
      want === 'reflect' || want === 'leave'
        ? decide(occupancy, want, pending)
        : decide(occupancy, want),
    ).toEqual(verdict)
  },
)

test.each([
  ['say', { kind: 'answered', lastText: 'Hi' }, null, null],
  ['say', { kind: 'failed', error: 'overloaded' }, null, null],
  [
    'say',
    { kind: 'session-lost', error: 'No conversation found' },
    { kind: 'record-missing' },
    { summary: 'SDK の記録が消えていたので、振り返らずに終えた', logged: true },
  ],
  [
    'reflect',
    { kind: 'answered', lastText: '\nRecorded two terms.\nAnd one LR.' },
    { kind: 'reflected', report: '\nRecorded two terms.\nAnd one LR.' },
    { summary: 'Recorded two terms.', logged: false },
  ],
  [
    'reflect',
    { kind: 'failed', error: 'overloaded\nmore' },
    { kind: 'reflection-failed', error: 'overloaded\nmore' },
    { summary: '振り返りの turn が失敗した: overloaded', logged: true },
  ],
] as const)(
  'a %s turn that ends %o ends the Study Conversation as %o and records %o',
  (mode, end, ending, record) => {
    const found = endingAfter(mode, end)
    expect(found).toEqual(ending)
    expect(found && recordOf(found)).toEqual(record)
  },
)

test('a Study Conversation ended without a reflection records no summary and no log.md line', () => {
  expect(recordOf({ kind: 'without-reflection' })).toEqual({ summary: null, logged: false })
})

type Asked = {
  studyId: string
  request: TutorRequest
  conversationId: string
  onEvent: (event: TutorEvent) => void
  finish: (end: TurnEnd) => void
}

// turn も interrupt もテストが解くまで終わらないので、await の途中で止めて順を決められる。
function fakeTutors() {
  const fake = {
    asked: [] as Asked[],
    interrupts: [] as { release(): void }[],
    closed: [] as string[],
    full: false,
    askUser: (_studyId: string): AskUser => {
      throw new Error('no Study Lifecycle yet')
    },
  }
  const finishLast = (studyId: string, end: TurnEnd) =>
    fake.asked.findLast((asked) => asked.studyId === studyId)?.finish(end)
  const tutors: TutorClaudes = {
    reply(studyId, request, prepare) {
      if (fake.full) return 'full'
      const { conversation, value, onEvent } = prepare()
      const { promise, resolve } = Promise.withResolvers<TurnEnd>()
      fake.asked.push({
        studyId,
        request,
        conversationId: conversation.id,
        onEvent,
        finish: resolve,
      })
      return { value, ended: promise }
    },
    interrupt(studyId) {
      const { promise, resolve } = Promise.withResolvers<void>()
      fake.interrupts.push({
        release: () => {
          finishLast(studyId, { kind: 'failed', error: 'interrupted' })
          resolve()
        },
      })
      return promise
    },
    async close(studyId) {
      fake.closed.push(studyId)
      finishLast(studyId, { kind: 'failed', error: 'killed' })
    },
    stop() {},
  }
  return {
    fake,
    factory: (askUser: (studyId: string) => AskUser) => {
      fake.askUser = askUser
      return tutors
    },
  }
}

function setup() {
  const db = inMemoryDb()
  const home = mkdtempSync(join(tmpdir(), 'monica-lifecycle-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const { fake, factory } = fakeTutors()
  const dirOf = (id: string) => join(home, 'studies', id)
  const lifecycle = createStudyLifecycle({
    db,
    home,
    dirOf,
    trashDir: join(home, 'trash', 'studies'),
    tutors: factory,
    runner: createRunner(),
    tools: { docker: null, nixStore: null },
    deleteSession: async () => {},
  })
  const start = () => {
    const id = `study-${Bun.randomUUIDv7()}`
    mkdirSync(dirOf(id), { recursive: true })
    db.insert(study).values({ id, createdAt: new Date(), lastActiveAt: new Date() }).run()
    return id
  }
  const pending = () =>
    db.select().from(studyMessage).where(eq(studyMessage.permissionState, 'pending')).all()
  return { db, home, fake, lifecycle, start, pending }
}

/** turn が箱の外の command の許可を待っている Study。 */
function waitingOnPermission(fixture: ReturnType<typeof setup>) {
  const { fake, lifecycle, start, pending } = fixture
  const id = start()
  expect(isRefusal(lifecycle.send(id, 'run docker ps', {}))).toBe(false)
  void fake.askUser(id)({ command: 'docker ps', description: 'List' }, new AbortController().signal)
  expect(pending()).toHaveLength(1)
  return { id, conversationId: fake.asked[0]!.conversationId }
}

test('ending a turn that waits on a permission holds the Study until the reflection turn starts, so a send in between is refused', async () => {
  const fixture = setup()
  const { fake, lifecycle, pending } = fixture
  const { id, conversationId } = waitingOnPermission(fixture)

  const ended = lifecycle.end(id, conversationId, true)
  await until(() => fake.interrupts.length === 1)

  expect(pending()).toEqual([])
  expect(lifecycle.send(id, 'slip in', {})).toMatchObject({ refused: 'conversation-ending' })
  fake.interrupts[0]!.release()
  expect(await ended).toBeUndefined()
  expect(fake.asked.map((asked) => asked.request.kind)).toEqual(['say', 'reflect'])
  expect(lifecycle.running(id)).toBe(true)
  expect(lifecycle.send(id, 'slip in', {})).toMatchObject({ refused: 'turn-running' })
})

test('a removal during the ending wins: the end is refused with study-removing and no reflection turn starts', async () => {
  const fixture = setup()
  const { fake, lifecycle, home } = fixture
  const { id, conversationId } = waitingOnPermission(fixture)
  const ended = lifecycle.end(id, conversationId, true)
  await until(() => fake.interrupts.length === 1)

  const removed = lifecycle.remove(id)
  fake.interrupts[0]!.release()

  expect(await ended).toEqual({ refused: 'study-removing', message: `${id} is being removed` })
  expect(await removed).toBeUndefined()
  expect(fake.asked.map((asked) => asked.request.kind)).toEqual(['say'])
  expect(existsSync(join(home, 'trash', 'studies', id, 'tree'))).toBe(true)
})

test('a send refused for the Tutor capacity writes no row and leaves the Study free', () => {
  const { db, fake, lifecycle, start } = setup()
  const id = start()
  fake.full = true

  expect(lifecycle.send(id, 'hello', {})).toMatchObject({ refused: 'tutor-capacity' })
  expect(db.select().from(studyMessage).all()).toEqual([])
  expect(lifecycle.running(id)).toBe(false)
  fake.full = false
  expect(isRefusal(lifecycle.send(id, 'hello', {}))).toBe(false)
})

test('the delta and Tutor rows of a turn feed the watch snapshot, which drops the text once its row is stored', async () => {
  const { fake, lifecycle, start } = setup()
  const id = start()
  lifecycle.send(id, 'hello', {})
  const [asked] = fake.asked
  asked!.onEvent({ type: 'delta', text: 'Hel' })
  asked!.onEvent({ type: 'delta', text: 'lo' })

  const during = await lifecycle.watch(id, undefined).next()
  asked!.onEvent({ type: 'tutor', text: 'Hello' })
  const after = await lifecycle.watch(id, undefined).next()

  expect(during.value).toMatchObject({ type: 'snapshot', running: true, partialText: 'Hello' })
  expect(after.value).toMatchObject({ type: 'snapshot', running: true, partialText: '' })
})
