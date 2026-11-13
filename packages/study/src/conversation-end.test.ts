import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'

import { systemJobs } from './server.ts'
import {
  type FakeClaude,
  init,
  result,
  said,
  shape,
  studyFixture,
  toolResult,
  toolUse,
  until,
} from './study-fixture.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const { setup, watching } = studyFixture(cleanups)

const T0 = new Date('2026-11-11T00:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

function clock(start: Date) {
  setSystemTime(start)
  cleanups.push(() => setSystemTime())
}

const turnEnds = (events: { type: string }[]) =>
  events.filter((event) => event.type === 'turn-ended').length

/** 1 往復を済ませた Study。 */
async function talked(fixture = setup()) {
  const { client, fake } = fixture
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init('session-a'), said('Hi'), result())
  await watch.ended()
  return { ...fixture, id, watch, claude }
}

const conversationJob = (fixture: ReturnType<typeof setup>) => {
  const job = systemJobs(fixture.studyLedger).find(
    (found) => found.name === 'study.conversation-end',
  )!
  return job
}

test('the system Job study.conversation-end runs every 5 minutes and ends a Study Conversation an hour after its last row without a reflection', async () => {
  clock(T0)
  const fixture = await talked()
  const { client, watch, claude, id, home } = fixture
  const logFile = join(home, 'studies', id, 'log.md')
  writeFileSync(logFile, '# Log\n')
  const job = conversationJob(fixture)
  expect(job.every).toBe(5 * 60_000)

  setSystemTime(at(60))
  await job.run()

  await watch.until((event) => event.type === 'conversation-ended')
  await claude.exited
  const [conversation] = (await client.get({ id })).conversations
  expect(conversation!.endedAt).not.toBeNull()
  expect(conversation!.summary).toBeNull()
  expect(conversation!.messages.map((m) => m.kind)).toEqual(['user', 'tutor'])
  expect(claude.prompts).toHaveLength(1)
  expect(watch.events.filter((event) => event.type === 'turn-started')).toHaveLength(1)
  expect(readFileSync(logFile, 'utf8')).toBe('# Log\n')
})

test('a Study Conversation whose last row is 59 minutes old stays', async () => {
  clock(T0)
  const fixture = await talked()
  const { client, watch, id } = fixture

  setSystemTime(at(59))
  await conversationJob(fixture).run()

  await Bun.sleep(20)
  expect(watch.events.filter((event) => event.type === 'turn-started')).toHaveLength(1)
  expect((await client.get({ id })).conversations[0]!.endedAt).toBeNull()
})

test('a send that takes the turn before the Job keeps the Study Conversation going', async () => {
  clock(T0)
  const fixture = await talked()
  const { client, watch, claude, id } = fixture

  setSystemTime(at(61))
  await client.send({ id, text: 'one more thing' })
  await conversationJob(fixture).run()
  claude.emit(said('Sure'), result())
  await until(() => turnEnds(watch.events) === 2)
  await conversationJob(fixture).run()

  await Bun.sleep(20)
  expect(watch.events.map(shape)).not.toContain('reflection:')
  expect((await client.get({ id })).conversations[0]!.endedAt).toBeNull()
})

test('the idle conversation Job skips a removal that finishes before its refusal is caught', async () => {
  clock(T0)
  const fixture = await talked()
  setSystemTime(at(61))
  const ended = fixture.claude.exited.then(() => fixture.studyLedger.endIdleConversations())

  await Promise.all([fixture.client.remove({ id: fixture.id }), ended])

  expect((await fixture.client.list({})).studies).toEqual([])
  expect(fixture.fake.claudes).toHaveLength(1)
})

test('a reflection left by a stopped Backend is started again', async () => {
  const before = await talked()
  await before.client.conversation.end({ id: before.id, reflect: true })
  await before.watch.until(
    (event) => event.type === 'message' && event.message.kind === 'reflection',
  )
  before.studyLedger.stop()
  await before.watch.until(() => turnEnds(before.watch.events) === 2)

  const after = setup({ db: before.db, home: before.home })
  const watch = await watching(after.client, before.id)
  await conversationJob(after).run()

  await until(() => after.fake.claudes.length === 1)
  const claude = after.fake.claudes[0]!
  expect(claude.options.resume).toBe('session-a')
  claude.emit(init('session-a'), said('Reflected.'), result())
  await watch.ended()
  const [conversation] = (await after.client.get({ id: before.id })).conversations
  expect(conversation!.summary).toBe('Reflected.')
  expect(conversation!.messages.filter((m) => m.kind === 'reflection')).toHaveLength(1)
})

test('conversation.end returns once the reflection turn has started, and watch streams the reflection row, the report and turn-ended', async () => {
  const { client, watch, claude, id } = await talked()
  const conversationId = (await client.get({ id })).conversations[0]!.id

  expect(await client.conversation.end({ id, reflect: true })).toEqual({ conversationId })
  expect((await client.get({ id })).running).toBe(true)

  claude.emit(toolUse('t1', 'Write', { file_path: 'log.md' }), toolResult('t1'), said('Done.'))
  claude.emit(result())
  await until(() => turnEnds(watch.events) === 2)
  expect(watch.events.slice(-6).map(shape)).toEqual([
    'turn-started',
    'reflection:',
    'tool:log.md',
    'tutor:Done.',
    `conversation-ended:${conversationId}`,
    'turn-ended:null',
  ])
})

test('the reflection turn writes the summary from the first line of the report, and the next send starts a new session', async () => {
  const { client, watch, claude, fake, id } = await talked()
  await client.conversation.end({ id, reflect: true })
  claude.emit(said('Looking back.'), said('\nRecorded two terms.\nAnd one LR.'), result())
  await until(() => turnEnds(watch.events) === 2)
  await claude.exited

  await client.send({ id, text: 'new topic' })
  await until(() => fake.claudes.length === 2)

  expect(fake.claudes[1]!.options.resume).toBeUndefined()
  const conversations = (await client.get({ id })).conversations
  expect(conversations.map((c) => [c.endedAt === null, c.summary])).toEqual([
    [true, null],
    [false, 'Recorded two terms.'],
  ])
})

test('conversation.end is refused with CONFLICT while a turn runs, and NOT_FOUND without an ongoing Study Conversation', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})

  await expect(client.conversation.end({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  await expect(client.conversation.end({ id })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `a turn is already running in ${id}`,
  })
  expect((await client.get({ id })).conversations[0]!.messages.map((m) => m.kind)).toEqual(['user'])
})

test('conversation.end without reflect ends the Study Conversation at once without a turn, and the next send starts a new session', async () => {
  const { client, watch, claude, fake, id, home } = await talked()
  const logFile = join(home, 'studies', id, 'log.md')
  writeFileSync(logFile, '# Log\n')
  const conversationId = (await client.get({ id })).conversations[0]!.id

  expect(await client.conversation.end({ id })).toEqual({ conversationId })

  const study = await client.get({ id })
  expect(study.running).toBe(false)
  expect(study.conversations[0]).toMatchObject({ summary: null })
  expect(study.conversations[0]!.endedAt).not.toBeNull()
  expect(study.conversations[0]!.messages.map((m) => m.kind)).toEqual(['user', 'tutor'])
  await claude.exited
  expect(claude.prompts).toHaveLength(1)
  expect(watch.events.filter((event) => event.type === 'turn-started')).toHaveLength(1)
  expect(readFileSync(logFile, 'utf8')).toBe('# Log\n')

  await client.send({ id, text: 'new topic' })
  await until(() => fake.claudes.length === 2)
  expect(fake.claudes[1]!.options.resume).toBeUndefined()
  expect((await client.get({ id })).conversations.map((c) => c.endedAt === null)).toEqual([
    true,
    false,
  ])
})

test('conversation.end without reflect is not refused while four Studies are in a turn, and with reflect it is TOO_MANY_REQUESTS', async () => {
  const fixture = await talked()
  const { client, fake, id } = fixture
  for (const text of ['a', 'b', 'c', 'd']) {
    const other = await client.start({})
    await client.send({ id: other.id, text })
  }
  await until(() => fake.claudes.length === 5)
  await fixture.claude.exited

  await expect(client.conversation.end({ id, reflect: true })).rejects.toMatchObject({
    code: 'TOO_MANY_REQUESTS',
    data: { reason: 'tutor-capacity' },
  })
  await client.conversation.end({ id })

  expect((await client.get({ id })).conversations[0]!.endedAt).not.toBeNull()
  expect(fake.claudes).toHaveLength(5)
})

function askOutside(claude: FakeClaude) {
  return claude.options.canUseTool!(
    'Bash',
    { command: 'docker ps', description: 'List containers', dangerouslyDisableSandbox: true },
    { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' },
  )
}

test('ending a Study Conversation denies its pending permission, interrupts the turn and reflects after it ends', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'run docker ps' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init())
  const asked = askOutside(claude)
  await watch.until((event) => event.type === 'message' && event.message.kind === 'permission')

  await client.conversation.end({ id, reflect: true })

  expect(await asked).toMatchObject({ behavior: 'deny' })
  expect(claude.interrupts).toBe(1)
  await watch.until((event) => event.type === 'message' && event.message.kind === 'reflection')
  expect(watch.events.slice(1).map(shape)).toEqual([
    'turn-started',
    'user:run docker ps',
    'permission:docker ps',
    'permission:docker ps',
    'turn-ended:interrupted',
    'turn-started',
    'reflection:',
  ])
})

test('ending a Study Conversation without reflect denies its pending permission, interrupts the turn and ends it without a reflection', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'run docker ps' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init())
  const asked = askOutside(claude)
  await watch.until((event) => event.type === 'message' && event.message.kind === 'permission')

  await client.conversation.end({ id })

  expect(await asked).toMatchObject({ behavior: 'deny' })
  expect(claude.interrupts).toBe(1)
  await claude.exited
  const [conversation] = (await client.get({ id })).conversations
  expect(conversation!.endedAt).not.toBeNull()
  expect(conversation!.summary).toBeNull()
  expect(conversation!.messages.map((m) => m.kind)).not.toContain('reflection')
  expect(watch.events.filter((event) => event.type === 'turn-started')).toHaveLength(1)
})

const NO_RECORD_SHELL =
  'echo "No conversation found with session ID: session-a" >&2; touch stderr-written; exit 1'

test('a Study Conversation whose SDK record is gone ends without a reflection, with its reason as the summary and one line at the end of log.md', async () => {
  const before = await talked()
  before.studyLedger.stop()
  const logFile = join(before.home, 'studies', before.id, 'log.md')
  writeFileSync(logFile, '# Log\n\n- read the README')
  const after = setup({ db: before.db, home: before.home })
  after.fake.shell = NO_RECORD_SHELL
  const watch = await watching(after.client, before.id)

  await after.client.conversation.end({ id: before.id, reflect: true })
  await watch.ended()

  expect(watch.events.at(-1)).toMatchObject({ type: 'turn-ended' })
  const [conversation] = (await after.client.get({ id: before.id })).conversations
  expect(conversation!.endedAt).not.toBeNull()
  expect(conversation!.summary).toBe('SDK の記録が消えていたので、振り返らずに終えた')
  expect(readFileSync(logFile, 'utf8')).toMatch(
    /^# Log\n\n- read the README\n- \S+ SDK の記録が消えていたので、振り返らずに終えた\n$/,
  )
})

test('a send whose resume finds no SDK record ends that Study Conversation, and the next send starts a new one', async () => {
  const before = await talked()
  before.studyLedger.stop()
  const after = setup({ db: before.db, home: before.home })
  after.fake.shell = NO_RECORD_SHELL
  const watch = await watching(after.client, before.id)

  await after.client.send({ id: before.id, text: 'do you remember?' })
  await watch.ended()
  after.fake.shell = 'sleep 60 & wait'
  await after.client.send({ id: before.id, text: 'again' })
  await until(() => after.fake.claudes.length === 2)

  expect(after.fake.claudes[1]!.options.resume).toBeUndefined()
  const conversations = (await after.client.get({ id: before.id })).conversations
  expect(conversations.map((c) => c.messages.map((m) => m.text))).toEqual([
    ['again'],
    ['hello', 'Hi', 'do you remember?'],
  ])
  expect(conversations[1]!.summary).toBe('SDK の記録が消えていたので、振り返らずに終えた')
})

test('a reflection turn that fails ends the Study Conversation and is not tried again', async () => {
  const fixture = await talked()
  const { client, watch, claude, id, home } = fixture
  await client.conversation.end({ id, reflect: true })
  claude.emit(result('overloaded'))
  await until(() => turnEnds(watch.events) === 2)

  const [conversation] = (await client.get({ id })).conversations
  expect(conversation!.endedAt).not.toBeNull()
  expect(conversation!.summary).toBe('振り返りの turn が失敗した: overloaded')
  expect(readFileSync(join(home, 'studies', id, 'log.md'), 'utf8')).toContain(
    '振り返りの turn が失敗した: overloaded',
  )
  await conversationJob(fixture).run()
  await Bun.sleep(20)
  expect(turnEnds(watch.events)).toBe(2)
})

test('log.md that the Tutor made a symlink is not followed', async () => {
  const fixture = await talked()
  const { client, watch, claude, id, home } = fixture
  const outside = join(home, 'outside.md')
  writeFileSync(outside, 'keep\n')
  symlinkSync(outside, join(realpathSync(join(home, 'studies', id)), 'log.md'))
  await client.conversation.end({ id, reflect: true })
  claude.emit(result('overloaded'))
  await until(() => turnEnds(watch.events) === 2)

  expect(readFileSync(outside, 'utf8')).toBe('keep\n')
  expect((await client.get({ id })).conversations[0]!.endedAt).not.toBeNull()
})

const preToolUse = (claude: FakeClaude) => claude.options.hooks!.PreToolUse![0]!.hooks[0]!

async function decide(hook: HookCallback, tool: string, input: object) {
  const output = await hook(
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as HookInput,
    undefined,
    { signal: new AbortController().signal },
  )
  return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision
}

test('the reflection turn lets Read, Write and Edit through and denies Bash, WebFetch and WebSearch', async () => {
  const { client, claude, id } = await talked()
  const hook = preToolUse(claude)
  expect(await decide(hook, 'Bash', { command: 'ls' })).toBeUndefined()

  await client.conversation.end({ id, reflect: true })

  expect(await decide(hook, 'Read', { file_path: 'MISSION.md' })).toBe('allow')
  expect(await decide(hook, 'Write', { file_path: 'log.md' })).toBe('allow')
  expect(await decide(hook, 'Edit', { file_path: 'GLOSSARY.md' })).toBe('allow')
  expect(await decide(hook, 'Bash', { command: 'ls' })).toBe('deny')
  expect(await decide(hook, 'WebFetch', { url: 'https://example.com' })).toBe('deny')
  expect(await decide(hook, 'WebSearch', { query: 'ky' })).toBe('deny')
})
