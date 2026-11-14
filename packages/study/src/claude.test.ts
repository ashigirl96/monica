import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTutorClaudes, type TutorConversation, type TutorEvent } from './claude.ts'
import {
  delta,
  fakeQuery,
  init,
  result,
  said,
  toolResult,
  toolUse,
  until,
} from './study-fixture.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'monica-claude-'))
  const fake = fakeQuery()
  const tutors = createTutorClaudes({
    home,
    tutorDir: join(import.meta.dir, '../tutors'),
    claudePath: undefined,
    query: fake.query,
    studyDir: (studyId) => {
      const dir = join(home, 'studies', studyId)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    askUser: () => async () => ({ allow: false, message: 'no' }),
  })
  cleanups.push(async () => {
    tutors.stop()
    await Promise.all(fake.claudes.map((claude) => claude.exited))
    rmSync(home, { recursive: true, force: true })
  })
  return { tutors, fake }
}

const conversation = (studyId: string, sessionId: string | null = null): TutorConversation => ({
  id: `sc-${studyId}`,
  startedAt: new Date('2026-11-11T03:04:05Z'),
  sessionId,
})

const say = (text: string) => ({ kind: 'say', text, choice: {} }) as const

function reply(
  tutors: ReturnType<typeof setup>['tutors'],
  studyId: string,
  options: { sessionId?: string; onEvent?: (event: TutorEvent) => void } = {},
) {
  const replied = tutors.reply(studyId, say('hello'), () => ({
    conversation: conversation(studyId, options.sessionId),
    value: studyId,
    onEvent: options.onEvent ?? (() => {}),
  }))
  if (replied === 'full') throw new Error(`no room for ${studyId}`)
  return replied
}

test('a turn streams the session, the Tutor text as deltas and a text, a tool once it ran and a Tutor switch, and ends answered with the last text', async () => {
  const { tutors, fake } = setup()
  const seen: TutorEvent[] = []
  const { value, ended } = reply(tutors, 'a', { onEvent: (event) => seen.push(event) })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(
    init('session-1'),
    delta('Hi'),
    said('Hi'),
    toolUse('t1', 'Bash', { command: 'ls -la\nrm -rf x' }),
    toolResult('t1'),
    toolUse('t2', 'Skill', { skill: 'tutors:repository' }),
    toolResult('t2'),
    toolUse('t3', 'Agent', { description: 'Find zod sources', subagent_type: 'researcher' }),
    toolResult('t3'),
    result(),
  )

  expect(value).toBe('a')
  expect(await ended).toEqual({ kind: 'answered', lastText: 'Hi' })
  expect(seen).toEqual([
    { type: 'session', sessionId: 'session-1' },
    { type: 'delta', text: 'Hi' },
    { type: 'tutor', text: 'Hi' },
    { type: 'tool', tool: 'Bash', text: 'ls -la' },
    { type: 'tutor-switch', tutor: 'repository' },
    { type: 'tool', tool: 'Agent', text: 'Find zod sources' },
  ])
  const next = reply(tutors, 'a')
  fake.claudes[0]!.emit(result())
  expect(await next.ended).toEqual({ kind: 'answered', lastText: '' })
  expect(fake.claudes).toHaveLength(1)
})

test('while four Studies answer, a fifth is full before prepare writes anything, and a prepare that throws stops no idle claude', async () => {
  const { tutors, fake } = setup()
  const first = reply(tutors, 'a')
  for (const studyId of ['b', 'c', 'd']) reply(tutors, studyId)
  await until(() => fake.claudes.length === 4)
  let prepared = false

  expect(
    tutors.reply('e', say('hello'), () => {
      prepared = true
      return { conversation: conversation('e'), value: null, onEvent: () => {} }
    }),
  ).toBe('full')
  expect(prepared).toBe(false)

  fake.claudes[0]!.emit(result())
  await first.ended
  expect(() =>
    tutors.reply('e', say('hello'), () => {
      throw new Error('the transaction failed')
    }),
  ).toThrow('the transaction failed')
  const again = reply(tutors, 'a')
  fake.claudes[0]!.emit(result())
  expect(await again.ended).toEqual({ kind: 'answered', lastText: '' })
  expect(fake.claudes).toHaveLength(4)
})

test('a fifth Study stops the idle claude whose last turn is oldest', async () => {
  const { tutors, fake } = setup()
  for (const studyId of ['a', 'b', 'c', 'd']) {
    const { ended } = reply(tutors, studyId)
    await until(() => fake.claudes.length > ['a', 'b', 'c', 'd'].indexOf(studyId))
    fake.claudes.at(-1)!.emit(result())
    await ended
  }

  reply(tutors, 'e')

  await fake.claudes[0]!.exited
  await until(() => fake.claudes.length === 5)
})

test('a claude whose resume finds no SDK record ends the turn session-lost, and one that exits mid-turn ends it failed with its stderr', async () => {
  const { tutors, fake } = setup()
  fake.shell = 'echo "No conversation found with session ID: session-a" >&2; exit 1'
  const lost = reply(tutors, 'a', { sessionId: 'session-a' })
  expect(await lost.ended).toMatchObject({ kind: 'session-lost' })

  fake.shell = 'echo crashed >&2; exit 1'
  const crashed = reply(tutors, 'b')
  expect(await crashed.ended).toEqual({ kind: 'failed', error: 'crashed\n' })
})

test('an onEvent that throws ends the turn failed and stops the claude, so the next turn wakes a new one', async () => {
  const { tutors, fake } = setup()
  const { ended } = reply(tutors, 'a', {
    onEvent: () => {
      throw new Error('the row could not be written')
    },
  })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(said('Hi'), result())

  expect(await ended).toEqual({ kind: 'failed', error: 'the row could not be written' })
  await fake.claudes[0]!.exited
  reply(tutors, 'a')
  await until(() => fake.claudes.length === 2)
})

test('stop ends a running turn as stopped, and a reply after it wakes no claude', async () => {
  const { tutors, fake } = setup()
  const { ended } = reply(tutors, 'a')
  await until(() => fake.claudes.length === 1)

  tutors.stop()

  expect(await ended).toMatchObject({ kind: 'stopped' })
  expect(await reply(tutors, 'b').ended).toMatchObject({ kind: 'stopped' })
  expect(fake.claudes).toHaveLength(1)
})
