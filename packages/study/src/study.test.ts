import { afterEach, expect, setSystemTime, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { study as studyTable } from './schema.ts'
import {
  delta,
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

const groupGone = (pid: number) => {
  try {
    process.kill(-pid, 0)
    return false
  } catch {
    return true
  }
}

test('start makes the Study dir under studies with mode 0700, and list shows the Study with no Mission yet', async () => {
  const { home, client } = setup()

  const { id } = await client.start({})

  expect(id).toMatch(/^study-/)
  expect(statSync(join(home, 'studies', id)).mode & 0o777).toBe(0o700)
  const { studies } = await client.list({})
  expect(studies).toEqual([
    {
      id,
      missionLine: null,
      firstMessage: null,
      lastActivityAt: expect.any(Date),
      lastLogLine: null,
      waitingPermission: false,
      playgroundRemoved: false,
      repos: [],
    },
  ])
  expect((await client.get({ id })).dir).toBe(join(home, 'studies', id))
})

test('list marks a Study whose Playground was removed after its last activity, and only that one', async () => {
  const { db, client } = setup()
  const removedAfter = await client.start({})
  const removedBefore = await client.start({})
  const never = await client.start({})
  const at = (id: string) =>
    db.select().from(studyTable).where(eq(studyTable.id, id)).get()!.lastActiveAt.getTime()
  const removedAt = (id: string, ms: number) =>
    db
      .update(studyTable)
      .set({ playgroundRemovedAt: new Date(ms) })
      .where(eq(studyTable.id, id))
      .run()
  removedAt(removedAfter.id, at(removedAfter.id) + 1)
  removedAt(removedBefore.id, at(removedBefore.id) - 1)

  const { studies } = await client.list({})

  expect(Object.fromEntries(studies.map((s) => [s.id, s.playgroundRemoved]))).toEqual({
    [removedAfter.id]: true,
    [removedBefore.id]: false,
    [never.id]: false,
  })
})

test('shell finds a Study by the head of its id, with or without study- and in any case, and gives its dir, its Playground env and the study ZDOTDIR', async () => {
  const { home, client } = setup()
  const { id } = await client.start({})
  const dir = join(home, 'studies', id)
  const expected = {
    studyId: id,
    dir,
    env: expect.objectContaining({
      MONICA_STUDY_DIR: dir,
      NPM_CONFIG_PREFIX: join(dir, 'env/npm'),
    }),
    zdotdir: join(home, 'shell/study/zdotdir'),
  }

  expect(await client.shell({ prefix: id.slice(6, 14) })).toEqual(expected)
  expect(await client.shell({ prefix: id.slice(0, 15).toUpperCase() })).toEqual(expected)
  expect(await client.shell({ prefix: id })).toEqual(expected)
  await expect(client.shell({ prefix: 'xyz' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('shell to a prefix no Study has is NOT_FOUND, and to one two Studies share is BAD_REQUEST naming both with their Mission', async () => {
  const { home, db, client } = setup()
  const now = new Date()
  for (const id of ['study-0190abcd-1111', 'study-0190abcd-2222']) {
    db.insert(studyTable).values({ id, createdAt: now, lastActiveAt: now }).run()
    mkdirSync(join(home, 'studies', id), { recursive: true })
  }
  writeFileSync(join(home, 'studies', 'study-0190abcd-1111', 'MISSION.md'), '# Understand ky\n')

  await expect(client.shell({ prefix: '0190abce' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: "no Study's id starts with 0190abce",
  })
  await expect(client.shell({ prefix: '0190abcd' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      '0190abcd matches 2 Studies: study-0190abcd-1111 (Understand ky), study-0190abcd-2222 (no Mission yet); give more of the id',
  })
})

test('shell into a Study moves it to the top of the list', async () => {
  const { client } = setup()
  try {
    setSystemTime(new Date('2026-11-11T00:00:00Z'))
    const older = await client.start({})
    setSystemTime(new Date('2026-11-11T01:00:00Z'))
    await client.start({})
    setSystemTime(new Date('2026-11-11T02:00:00Z'))

    await client.shell({ prefix: older.id })

    expect((await client.list({})).studies[0]!.id).toBe(older.id)
  } finally {
    setSystemTime()
  }
})

test('list names a Study by the first line of MISSION.md without its #, shows the last line of log.md, and puts the newest activity first', async () => {
  const { home, client } = setup()
  try {
    setSystemTime(new Date('2026-11-11T00:00:00Z'))
    const older = await client.start({})
    setSystemTime(new Date('2026-11-11T01:00:00Z'))
    const newer = await client.start({})
    writeFileSync(join(home, 'studies', older.id, 'MISSION.md'), '\n# Understand ky\n\nWhy...\n')
    writeFileSync(
      join(home, 'studies', older.id, 'log.md'),
      '# Log\n\n## 2026-11-11\n\n- read the README\n- quizzed on hooks\n\n',
    )

    const { studies } = await client.list({})

    expect(
      studies.map(({ id, missionLine, lastLogLine }) => ({ id, missionLine, lastLogLine })),
    ).toEqual([
      { id: newer.id, missionLine: null, lastLogLine: null },
      { id: older.id, missionLine: 'Understand ky', lastLogLine: 'quizzed on hooks' },
    ])
  } finally {
    setSystemTime()
  }
})

test('send stores the utterance and returns its row without waiting for the turn', async () => {
  const { client } = setup()
  const { id } = await client.start({})

  const { message } = await client.send({ id, text: 'I want to read ky\nsecond line' })

  expect(message).toMatchObject({
    kind: 'user',
    text: 'I want to read ky\nsecond line',
    tool: null,
  })
  const study = await client.get({ id })
  expect(study.conversations[0]!.messages).toEqual([message])
  expect(study.firstMessage).toBe('I want to read ky')
  expect((await client.list({})).studies[0]!.firstMessage).toBe('I want to read ky')
})

test('watch streams a turn as turn-started, the user row, Tutor text as deltas and a row, a tool row once the tool has run, and turn-ended', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)

  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init(), delta('Let me '), delta('look.'), said('Let me look.'))
  claude.emit(toolUse('t1', 'Bash', { command: `ls ${'x'.repeat(300)}\necho second` }), delta('.'))
  await watch.until((event) => event.type === 'delta' && event.text === '.')
  expect(
    watch.events.some((event) => event.type === 'message' && event.message.kind === 'tool'),
  ).toBe(false)
  claude.emit(
    toolResult('t1'),
    toolUse('t2', 'Read', { file_path: 'MISSION.md' }),
    toolResult('t2'),
  )
  claude.emit(result())
  await watch.ended()

  expect(watch.events.map(shape)).toEqual([
    'snapshot',
    'turn-started',
    'user:hello',
    'delta:Let me ',
    'delta:look.',
    'tutor:Let me look.',
    'delta:.',
    `tool:ls ${'x'.repeat(197)}`,
    'tool:MISSION.md',
    'turn-ended:null',
  ])
  const tools = watch.events.flatMap((event) =>
    event.type === 'message' && event.message.kind === 'tool' ? [event.message.tool] : [],
  )
  expect(tools).toEqual(['Bash', 'Read'])
})

test('a watch opened in the middle of a turn starts from a snapshot of the running flag, the last stored row and the Tutor text so far, and then misses no event', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const first = await watching(client, id)
  const { message } = await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init(), delta('Hel'))
  await first.until((event) => event.type === 'delta')

  const second = await watching(client, id)
  claude.emit(delta('lo'), said('Hello'), result())
  await second.ended()

  expect(second.events[0]).toEqual({
    type: 'snapshot',
    running: true,
    lastMessageId: message.id,
    partialText: 'Hel',
  })
  expect(second.events.slice(1).map(shape)).toEqual(['delta:lo', 'tutor:Hello', 'turn-ended:null'])
})

test('two watches of a Study get the same events, and closing one stops neither the turn nor the other watch', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const first = await watching(client, id)
  const second = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init(), delta('Hi'))
  await first.until((event) => event.type === 'delta')
  await second.until((event) => event.type === 'delta')

  first.close()
  claude.emit(said('Hi'), result())
  await second.ended()

  expect(second.events.map(shape)).toEqual([
    'snapshot',
    'turn-started',
    'user:hello',
    'delta:Hi',
    'tutor:Hi',
    'turn-ended:null',
  ])
  expect(first.events.map(shape)).toEqual(second.events.slice(0, 4).map(shape))
  expect((await client.get({ id })).conversations[0]!.messages.map((m) => m.kind)).toEqual([
    'user',
    'tutor',
  ])
})

test('a Skill call of a Tutor writes a Tutor switch row only when the Tutor changes', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)

  fake.claudes[0]!.emit(
    init(),
    toolUse('s1', 'Skill', { skill: 'tutors:repository' }),
    toolResult('s1'),
    toolUse('s2', 'Skill', { skill: 'tutors:repository' }),
    toolResult('s2'),
    toolUse('s3', 'Skill', { skill: 'tutors:paper' }),
    toolResult('s3'),
    result(),
  )
  await watch.ended()

  expect(
    watch.events.map(shape).filter((s) => s.startsWith('tutor_switch') || s.startsWith('tool')),
  ).toEqual(['tutor_switch:repository', 'tutor_switch:paper'])
})

test('get returns the rows that watch streamed, in order, and says whether a turn is running', async () => {
  const { client, fake } = setup()
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(
    init(),
    said('Hi'),
    toolUse('t1', 'WebSearch', { query: 'ky' }),
    toolResult('t1'),
  )
  await watch.until((event) => event.type === 'message' && event.message.kind === 'tool')

  expect((await client.get({ id })).running).toBe(true)

  fake.claudes[0]!.emit(result())
  await watch.ended()
  const study = await client.get({ id })
  const streamed = watch.events.flatMap((event) =>
    event.type === 'message' ? [event.message] : [],
  )
  expect(study.running).toBe(false)
  expect(study.conversations).toHaveLength(1)
  expect(study.conversations[0]!.messages).toEqual(streamed)
  expect(streamed.map((m) => m.text)).toEqual(['hello', 'Hi', 'ky'])
})

test('a second send to a Study whose turn is running is refused with CONFLICT and writes no row, while another Study answers', async () => {
  const { client } = setup()
  const busy = await client.start({})
  const other = await client.start({})
  await client.send({ id: busy.id, text: 'first' })

  await expect(client.send({ id: busy.id, text: 'second' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `a turn is already running in ${busy.id}`,
  })
  expect((await client.get({ id: busy.id })).conversations[0]!.messages).toHaveLength(1)
  expect((await client.send({ id: other.id, text: 'hi' })).message.text).toBe('hi')
})

test('last_active_at moves at each utterance and at the end of each turn, failed or not', async () => {
  const { client, fake } = setup()
  const activity = async () => (await client.list({})).studies[0]!.lastActivityAt.toISOString()
  try {
    setSystemTime(new Date('2026-11-11T00:00:00Z'))
    const { id } = await client.start({})
    const watch = await watching(client, id)
    expect(await activity()).toBe('2026-11-11T00:00:00.000Z')

    setSystemTime(new Date('2026-11-11T01:00:00Z'))
    await client.send({ id, text: 'hello' })
    expect(await activity()).toBe('2026-11-11T01:00:00.000Z')

    setSystemTime(new Date('2026-11-11T02:00:00Z'))
    await until(() => fake.claudes.length === 1)
    fake.claudes[0]!.emit(init(), result())
    await watch.ended()
    expect(await activity()).toBe('2026-11-11T02:00:00.000Z')

    setSystemTime(new Date('2026-11-11T03:00:00Z'))
    await client.send({ id, text: 'again' })
    setSystemTime(new Date('2026-11-11T04:00:00Z'))
    fake.claudes[0]!.emit(result('overloaded'))
    await until(() => watch.events.filter((event) => event.type === 'turn-ended').length === 2)
    expect(watch.events.at(-1)).toEqual({ type: 'turn-ended', error: 'overloaded' })
    expect(await activity()).toBe('2026-11-11T04:00:00.000Z')
  } finally {
    setSystemTime()
  }
})

test('the first message of a Study Conversation says when it started, and later ones do not', async () => {
  const { client, fake } = setup()
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    setSystemTime(new Date('2026-11-11T03:04:05Z'))
    const { id } = await client.start({})
    const watch = await watching(client, id)
    await client.send({ id, text: 'hello' })
    await until(() => fake.claudes[0]?.prompts.length === 1)
    fake.claudes[0]!.emit(init(), result())
    await watch.ended()
    await client.send({ id, text: 'next' })
    await until(() => fake.claudes[0]!.prompts.length === 2)

    expect(fake.claudes[0]!.prompts).toEqual([
      'Study Conversation started at 2026-11-11T12:04:05+09:00\nhello',
      'next',
    ])
  } finally {
    setSystemTime()
    process.env.TZ = tz ?? 'UTC'
  }
})

test('the claude of a Study runs in its Study dir with the Tutors plugin, its skills, no setting sources, the teaching as the system prompt and the box', async () => {
  const { home, client, fake } = setup()
  const { id } = await client.start({})

  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)

  const tutorDir = join(import.meta.dir, '../tutors')
  const { options } = fake.claudes[0]!
  expect(options.cwd).toBe(realpathSync(join(home, 'studies', id)))
  expect(options.title).toBe(id)
  expect(options.plugins).toEqual([{ type: 'local', path: tutorDir, skipMcpDiscovery: true }])
  expect(options.skills).toEqual(['tutors:repository'])
  expect(options.settingSources).toEqual([])
  expect(options.includePartialMessages).toBe(true)
  expect(options.persistSession).toBeUndefined()
  expect(options.resume).toBeUndefined()
  expect(options.systemPrompt).toBe(
    `${readFileSync(join(tutorDir, 'TEACHING.md'), 'utf8')}\nThe Learning Preference file is ${join(home, 'learning-preference', 'LEARNING-PREFERENCE.md')}\n`,
  )
  expect(statSync(join(home, 'learning-preference')).mode & 0o777).toBe(0o700)
  expect(options.sandbox?.enabled).toBe(true)
  expect(options.additionalDirectories).toEqual([
    realpathSync(tutorDir),
    realpathSync(join(home, 'learning-preference')),
  ])
})

test('a Ledger given a Tutor dir passes it as the plugin and reads the teaching and the skills from it', async () => {
  const tutorsDir = mkdtempSync(join(tmpdir(), 'monica-tutors-'))
  cleanups.push(() => rmSync(tutorsDir, { recursive: true, force: true }))
  mkdirSync(join(tutorsDir, 'skills/web'), { recursive: true })
  writeFileSync(join(tutorsDir, 'TEACHING.md'), 'Teach from home.\n')
  const { home, client, fake } = setup({ tutorsDir })
  const { id } = await client.start({})

  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)

  const { options } = fake.claudes[0]!
  expect(options.plugins).toEqual([{ type: 'local', path: tutorsDir, skipMcpDiscovery: true }])
  expect(options.skills).toEqual(['tutors:web'])
  expect(options.systemPrompt).toBe(
    `Teach from home.\n\nThe Learning Preference file is ${join(home, 'learning-preference', 'LEARNING-PREFERENCE.md')}\n`,
  )
})

test('the claude env carries the allowlisted keys, the PATH without dirs under HOME, CLAUDE_ENV_FILE and the Playground env, and no other key of the Backend env', async () => {
  const { home, client, fake } = setup()
  const { id } = await client.start({})
  const path = process.env.PATH
  process.env.PATH = `${homedir()}/.local/bin:/usr/bin:${homedir()}:/bin`
  process.env.MONICA_STUDY_TEST_SECRET = 'leak'
  try {
    await client.send({ id, text: 'hello' })
    await until(() => fake.claudes.length === 1)
  } finally {
    process.env.PATH = path
    delete process.env.MONICA_STUDY_TEST_SECRET
  }

  const env = fake.claudes[0]!.options.env!
  expect(Object.keys(env).toSorted()).toEqual(
    [
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CODE_RESTRICTED',
      'CLAUDE_CODE_TMPDIR',
      'CARGO_HOME',
      'CLAUDE_ENV_FILE',
      'COMPOSE_PROJECT_NAME',
      'DISABLE_AUTOUPDATER',
      'ENABLE_CLAUDEAI_MCP_SERVERS',
      'HOME',
      'MISE_DATA_DIR',
      'MONICA_STUDY_DIR',
      'MONICA_STUDY_ID',
      'NPM_CONFIG_PREFIX',
      'PATH',
      'npm_config_cache',
      ...(process.env.USER ? ['USER'] : []),
    ].toSorted(),
  )
  expect(env.PATH).toBe('/usr/bin:/bin')
  expect(env.HOME).toBe(process.env.HOME)
  expect(env.CLAUDE_ENV_FILE).toBe(join(home, 'studies', id, '.claude-env.sh'))
  expect(env.MONICA_STUDY_ID).toBe(id)
  expect(env.NPM_CONFIG_PREFIX).toBe(join(home, 'studies', id, 'env/npm'))
})

test('the env file of a Study points HOME under env and sources env/env.sh, and is written again with the same content before each claude starts', async () => {
  const { home, client, fake } = setup()
  const { id } = await client.start({})
  const dir = join(home, 'studies', id)
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)

  const envFile = join(dir, '.claude-env.sh')
  const written = readFileSync(envFile, 'utf8')
  expect(written).toBe(
    `export HOME='${dir}/env/home'\nif [ -f '${dir}/env/env.sh' ]; then . '${dir}/env/env.sh'; fi\n`,
  )

  writeFileSync(envFile, 'export HOME=/\n')
  process.kill(-fake.claudes[0]!.pid, 'SIGKILL')
  await watch.ended()
  await client.send({ id, text: 'again' })
  await until(() => fake.claudes.length === 2)
  expect(readFileSync(envFile, 'utf8')).toBe(written)
})

test('a Ledger made again on the same DB resumes the Study Conversation by its session id', async () => {
  const before = setup()
  const { id } = await before.client.start({})
  const watch = await watching(before.client, id)
  await before.client.send({ id, text: 'hello' })
  await until(() => before.fake.claudes.length === 1)
  before.fake.claudes[0]!.emit(init('session-a'), said('Hi'), result())
  await watch.ended()
  before.studyLedger.stop()

  const after = setup({ db: before.db, home: before.home })
  await after.client.send({ id, text: 'do you remember?' })
  await until(() => after.fake.claudes[0]?.prompts.length === 1)

  expect(after.fake.claudes[0]!.options.resume).toBe('session-a')
  expect(after.fake.claudes[0]!.prompts).toEqual(['do you remember?'])
  expect((await after.client.get({ id })).conversations).toHaveLength(1)
})

test('a claude that exits in a turn ends it with turn-ended carrying its stderr, and the next send resumes', async () => {
  const { home, client, fake } = setup()
  // cwd は Study の dir なので、stderr を書き終えた印を test から見られる。
  fake.shell = 'echo claude crashed >&2; touch stderr-written; sleep 60 & wait'
  const { id } = await client.start({})
  const written = join(realpathSync(join(home, 'studies', id)), 'stderr-written')
  const watch = await watching(client, id)
  await client.send({ id, text: 'hello' })
  await until(() => fake.claudes.length === 1)
  fake.claudes[0]!.emit(init('session-b'))
  await until(() => fake.claudes[0]!.prompts.length === 1 && existsSync(written))

  process.kill(-fake.claudes[0]!.pid, 'SIGKILL')
  await watch.ended()

  expect(watch.events.at(-1)).toEqual({ type: 'turn-ended', error: 'claude crashed\n' })
  expect((await client.get({ id })).running).toBe(false)
  await client.send({ id, text: 'again' })
  await until(() => fake.claudes.length === 2)
  expect(fake.claudes[1]!.options.resume).toBe('session-b')
})

test('a fifth Study stops the idle claude whose turn is oldest, and send is refused with TOO_MANY_REQUESTS while all four are in a turn', async () => {
  const { client, fake } = setup()
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const { id } = await client.start({})
    const watch = await watching(client, id)
    await client.send({ id, text: 'hello' })
    await until(() => fake.claudes.length === i + 1)
    fake.claudes[i]!.emit(init(`session-${i}`), result())
    await watch.ended()
    ids.push(id)
  }

  const fifth = await client.start({})
  await client.send({ id: fifth.id, text: 'hello' })
  await until(() => fake.claudes.length === 5)
  await fake.claudes[0]!.exited

  expect(groupGone(fake.claudes[0]!.pid)).toBe(true)
  expect(groupGone(fake.claudes[1]!.pid)).toBe(false)
  for (const id of ids.slice(1)) await client.send({ id, text: 'busy' })
  await expect(client.send({ id: ids[0]!, text: 'hello' })).rejects.toMatchObject({
    code: 'TOO_MANY_REQUESTS',
  })
  expect((await client.get({ id: ids[0]! })).conversations[0]!.messages).toHaveLength(1)
})

test('stop kills the process group of every claude', async () => {
  const { client, fake, studyLedger } = setup()
  for (let i = 0; i < 2; i++) {
    const { id } = await client.start({})
    await client.send({ id, text: 'hello' })
  }
  await until(() => fake.claudes.length === 2)

  studyLedger.stop()

  await Promise.all(fake.claudes.map((claude) => claude.exited))
  for (const claude of fake.claudes) await until(() => groupGone(claude.pid))
})

test('send and watch to a Study that does not exist are NOT_FOUND', async () => {
  const { client } = setup()
  const id = 'study-0000'

  await expect(client.send({ id, text: 'hello' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(client.watch({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(client.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
