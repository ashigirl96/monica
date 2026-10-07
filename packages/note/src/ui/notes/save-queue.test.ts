import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import type { Doc } from '../../contract.ts'
import { type NoteDraft, type SaveInput, SaveQueue } from './save-queue.ts'

const V1 = new Date('2026-10-06T10:00:00.000Z')
const V2 = new Date('2026-10-06T10:00:00.001Z')
const V3 = new Date('2026-10-06T10:00:00.002Z')

afterEach(() => {
  mock.restore()
})

const doc = (text: string): Doc => ({ type: 'doc', content: [{ type: 'text', text }] })

function draft(text: string): NoteDraft {
  return { content: { toJSON: () => doc(text) } }
}

// timer が始めた flush は、偽の保存がすぐ応えるので次の macrotask までに終わる。
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

function noop() {}

function captureTimers() {
  const timers: { run: () => void; ms: number | undefined; cleared: boolean }[] = []
  spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number) => {
    timers.push({ run, ms, cleared: false })
    return timers.length as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: number) => {
    const timer = timers[handle - 1]
    if (timer) timer.cleared = true
  }) as typeof clearTimeout)
  return {
    timers,
    live: () => timers.filter((t) => !t.cleared),
  }
}

function setup() {
  const clock = captureTimers()
  const answers: (() => Promise<{ updatedAt: Date }>)[] = []
  const calls: { input: SaveInput; keepalive: boolean }[] = []
  const queue = new SaveQueue((input, keepalive) => {
    calls.push({ input, keepalive })
    const answer = answers.shift() ?? (() => Promise.resolve({ updatedAt: V2 }))
    return answer()
  })
  queue.setBase('note-1', V1)
  return { queue, calls, answers, clock }
}

test('an edit is saved a second after the last change, on the version last read, and a Daily sends no title', async () => {
  const { queue, calls, clock } = setup()

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  queue.schedule('note-1', draft('ab'), 'TUE 10.6')
  expect(clock.live().map((t) => t.ms)).toEqual([1000])
  expect(calls).toEqual([])

  clock.live()[0]!.run()
  await settle()

  expect(calls).toEqual([
    { input: { id: 'note-1', content: doc('ab'), expectedUpdatedAt: V1 }, keepalive: false },
  ])
  expect('title' in calls[0]!.input).toBe(false)
})

test('a title given with the edit is sent with it', async () => {
  const { queue, calls } = setup()

  queue.schedule('note-1', { ...draft('a'), title: 'On Rust' }, 'On Rust')
  await queue.flush()

  expect(calls[0]!.input.title).toBe('On Rust')
})

test('a save that goes through moves the version on, so the next save is made on it', async () => {
  const { queue, calls } = setup()

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  await queue.flush()
  queue.schedule('note-1', draft('ab'), 'TUE 10.6')
  await queue.flush()

  expect(calls.map((c) => c.input.expectedUpdatedAt)).toEqual([V1, V2])
  expect(queue.baseVersion('note-1')).toEqual(V2)
})

test('a CONFLICT is not retried: the Note is listed under its label, keeps its edit unsaved, and its version stays', async () => {
  const { queue, calls, answers, clock } = setup()
  answers.push(() => Promise.reject(new ORPCError('CONFLICT', { message: 'stale' })))

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  await queue.flush()

  expect(queue.conflicts()).toEqual([{ id: 'note-1', label: 'TUE 10.6' }])
  expect(queue.errors()).toEqual({})
  expect(queue.hasUnsaved('note-1')).toBe(true)
  expect(clock.live()).toEqual([])

  queue.setBase('note-1', V3)
  expect(queue.baseVersion('note-1')).toEqual(V1)
  expect(calls).toHaveLength(1)
})

test('any other failure keeps the edit and retries it every five seconds until it goes through, which clears the error', async () => {
  const { queue, calls, answers, clock } = setup()
  answers.push(() => Promise.reject(new TypeError('Failed to fetch')))
  answers.push(() => Promise.reject(new ORPCError('NOT_FOUND', { message: 'gone' })))

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  await queue.flush()
  expect(queue.errors()).toEqual({ 'note-1': 'Failed to fetch' })
  expect(queue.hasUnsaved('note-1')).toBe(true)
  expect(clock.live().map((t) => t.ms)).toEqual([5000])

  clock.live()[0]!.run()
  await settle()
  expect(queue.errors()).toEqual({ 'note-1': 'gone' })

  clock.live()[0]!.run()
  await settle()
  expect(calls).toHaveLength(3)
  expect(queue.errors()).toEqual({})
  expect(queue.hasUnsaved('note-1')).toBe(false)
  expect(queue.conflicts()).toEqual([])
})

test('saves go one after another: a flush waits for the one before it and saves on the version it returned', async () => {
  const { queue, calls, answers } = setup()
  let release = noop
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ updatedAt: V2 })
      }),
  )
  answers.push(() => Promise.resolve({ updatedAt: V3 }))

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  const first = queue.flush()
  await Promise.resolve()
  queue.schedule('note-1', draft('ab'), 'TUE 10.6')
  const second = queue.flush()
  await Promise.resolve()
  expect(calls).toHaveLength(1)

  release()
  await first
  await second

  expect(calls.map((c) => c.input.expectedUpdatedAt)).toEqual([V1, V2])
  expect(queue.baseVersion('note-1')).toEqual(V3)
})

test('a flush on pagehide sends the saves with keepalive', async () => {
  const { queue, calls } = setup()

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  await queue.flush(true)

  expect(calls[0]!.keepalive).toBe(true)
})

test('leaving loses nothing while edits wait for or are on their way to a Backend that answers, since pagehide sends them', async () => {
  const { queue, answers } = setup()
  let release = noop
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ updatedAt: V2 })
      }),
  )

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  expect(queue.wouldLoseOnLeave(false)).toBe(false)
  const sending = queue.flush()
  await Promise.resolve()
  expect(queue.wouldLoseOnLeave(false)).toBe(false)
  release()
  await sending

  expect(queue.wouldLoseOnLeave(true)).toBe(false)
})

test('an edit on its way counts as lost on leaving once the Backend is unreachable', async () => {
  const { queue, answers } = setup()
  let release = noop
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ updatedAt: V2 })
      }),
  )

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  const sending = queue.flush()
  await Promise.resolve()

  expect(queue.wouldLoseOnLeave(true)).toBe(true)
  release()
  await sending
})

test('an edit waiting behind a save on its way counts as lost on leaving, since the pagehide flush queues behind that save', async () => {
  const { queue, answers } = setup()
  let release = noop
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ updatedAt: V2 })
      }),
  )

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  const sending = queue.flush()
  await Promise.resolve()
  queue.schedule('note-1', draft('ab'), 'TUE 10.6')

  expect(queue.wouldLoseOnLeave(false)).toBe(true)
  release()
  await sending
  await queue.flush()
  expect(queue.wouldLoseOnLeave(false)).toBe(false)
})

test('leaving would lose an edit while the Backend is unreachable, one waiting to retry, and one left by a CONFLICT until the latest is read', async () => {
  const { queue, answers } = setup()
  answers.push(() => Promise.reject(new TypeError('Failed to fetch')))
  answers.push(() => Promise.reject(new ORPCError('CONFLICT', { message: 'stale' })))

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  expect(queue.wouldLoseOnLeave(true)).toBe(true)

  await queue.flush()
  expect(queue.wouldLoseOnLeave(false)).toBe(true)

  await queue.flush()
  expect(queue.conflicts()).toHaveLength(1)
  expect(queue.wouldLoseOnLeave(false)).toBe(true)

  queue.dropPending('note-1')
  expect(queue.wouldLoseOnLeave(false)).toBe(false)
  expect(queue.conflicts()).toEqual([])
  expect(queue.baseVersion('note-1')).toBeNull()
})

test('a change to the errors or the conflicts is told to the subscribers', async () => {
  const { queue, answers } = setup()
  const changed = mock(() => {})
  queue.subscribe(changed)
  answers.push(() => Promise.reject(new TypeError('Failed to fetch')))
  answers.push(() => Promise.reject(new ORPCError('CONFLICT', { message: 'stale' })))

  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  await queue.flush()
  expect(changed).toHaveBeenCalled()
  const errors = queue.errors()

  changed.mockClear()
  await queue.flush()
  expect(changed).toHaveBeenCalled()
  expect(queue.conflicts()).toHaveLength(1)
  expect(queue.errors()).not.toBe(errors)
})

test('the unsaved edit of a Note is its newest draft, whether it waits, is on its way or is left by a CONFLICT, and there is none once saved', async () => {
  const { queue, answers } = setup()
  let release = noop
  answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ updatedAt: V2 })
      }),
  )
  answers.push(() => Promise.reject(new ORPCError('CONFLICT', { message: 'stale' })))

  expect(queue.unsavedDraft('note-1')).toBeNull()
  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  expect(queue.unsavedDraft('note-1')).toEqual({ content: doc('a') })

  const sending = queue.flush()
  await Promise.resolve()
  expect(queue.unsavedDraft('note-1')).toEqual({ content: doc('a') })
  queue.schedule('note-1', { ...draft('ab'), title: 'On ledgers' }, 'On ledgers')
  expect(queue.unsavedDraft('note-1')).toEqual({ content: doc('ab'), title: 'On ledgers' })
  release()
  await sending
  expect(queue.unsavedDraft('note-1')).toEqual({ content: doc('ab'), title: 'On ledgers' })

  await queue.flush()
  expect(queue.conflicts()).toHaveLength(1)
  expect(queue.unsavedDraft('note-1')).toEqual({ content: doc('ab'), title: 'On ledgers' })

  queue.dropPending('note-1')
  expect(queue.unsavedDraft('note-1')).toBeNull()
})

test('each edit of a Note moves its edit mark, and an edit of another Note does not', () => {
  const { queue } = setup()

  const before = queue.editMark('note-1')
  queue.schedule('note-2', draft('a'), 'WED 10.7')
  expect(queue.editMark('note-1')).toBe(before)
  queue.schedule('note-1', draft('a'), 'TUE 10.6')
  expect(queue.editMark('note-1')).not.toBe(before)
})
