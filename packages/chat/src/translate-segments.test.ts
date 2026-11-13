import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'

import type { TranslateSegmentsInput } from './contract.ts'
import { createChatAgent, router } from './server.ts'
import { type FakeScenario, untilFakeClaudesExit, writeFakeClaude } from './testing.ts'

type ClaudeRecord =
  | { pid: number; kind: 'start'; argv: string[] }
  | { pid: number; kind: 'initialize'; request: { [key: string]: unknown } }
  | { pid: number; kind: 'user'; content: { type: string; text?: string }[] | string }
  | { pid: number; kind: 'eof' | 'sigterm' }

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

async function until<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function start(scenario?: FakeScenario) {
  const home = mkdtempSync(join(tmpdir(), 'monica-translate-'))
  const recordPath = join(home, 'claude.jsonl')
  const chatAgent = createChatAgent({
    home,
    claudePath: writeFakeClaude(home, recordPath, scenario),
  })
  const records = () =>
    readFileSync(recordPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClaudeRecord)
  cleanups.push(async () => {
    chatAgent.stop()
    await untilFakeClaudesExit(home)
    rmSync(home, { recursive: true, force: true })
  })
  return { client: createRouterClient(router, { context: { chatAgent } }), records }
}

const INPUT: TranslateSegmentsInput = {
  segments: [
    { id: 0, text: 'Tide pools' },
    { id: 1, text: 'The <g0>animals</g0> there survive <x1/>.' },
  ],
}

const HELD: TranslateSegmentsInput = { segments: [{ id: 0, text: 'HOLD' }] }

const pairs = (argv: string[]) => argv.map((arg, i) => [arg, argv[i + 1]])

const userPids = (records: ClaudeRecord[]) =>
  records.flatMap((r) => (r.kind === 'user' ? [r.pid] : []))

async function holdTranslations(
  client: ReturnType<typeof start>['client'],
  records: () => ClaudeRecord[],
  n: number,
) {
  for (let i = 0; i < n; i++) void client.translateSegments(HELD).catch(() => {})
  return until(() => (userPids(records()).length === n ? userPids(records()) : undefined))
}

test('translateSegments returns the segments that claude gave back as its structured output', async () => {
  const { client } = start()

  expect(await client.translateSegments(INPUT)).toEqual({
    segments: [
      { id: 0, text: '訳 Tide pools' },
      { id: 1, text: '訳 The <g0>animals</g0> there survive <x1/>.' },
    ],
  })
})

test('claude translates as haiku at medium effort with no tools, a JSON schema and a prompt about keeping the tags, and reads the segments as JSON', async () => {
  const { client, records } = start()

  await client.translateSegments(INPUT)

  const started = records().find((r) => r.kind === 'start')
  const initialize = records().find((r) => r.kind === 'initialize')
  const user = records().find((r) => r.kind === 'user')
  if (started?.kind !== 'start' || initialize?.kind !== 'initialize' || user?.kind !== 'user') {
    throw new Error('no claude')
  }
  expect(pairs(started.argv)).toContainEqual(['--model', 'haiku'])
  expect(pairs(started.argv)).toContainEqual(['--effort', 'medium'])
  expect(pairs(started.argv)).toContainEqual(['--tools', ''])
  expect(initialize.request).toMatchObject({
    title: 'Page Translation',
    jsonSchema: { type: 'object', required: ['segments'] },
    systemPrompt: [expect.stringMatching(/Japanese.*<gN>.*<xN\/>.*exactly once/s)],
  })
  const text = typeof user.content === 'string' ? user.content : user.content[0]?.text
  expect(JSON.parse(text!)).toEqual(INPUT)
})

test('a fifth translation while four claudes translate is refused as CHAT_BUSY, and so is a question to Chat', async () => {
  const { client, records } = start()
  await holdTranslations(client, records, 4)

  await expect(client.translateSegments(INPUT)).rejects.toMatchObject({
    code: 'CHAT_BUSY',
    status: 429,
  })
  await expect(
    client.ask({
      question: 'What?',
      page: { content: { kind: 'unreadable', reason: 'restricted' } },
      history: [],
    }),
  ).rejects.toMatchObject({ code: 'CHAT_BUSY' })
  expect(records().filter((r) => r.kind === 'start')).toHaveLength(4)
})

test('aborting a translation kills the claude that translates', async () => {
  const { client, records } = start()
  const controller = new AbortController()
  const translation = client.translateSegments(HELD, { signal: controller.signal })
  const [pid] = await until(() => (userPids(records()).length ? userPids(records()) : undefined))

  controller.abort()

  await expect(translation).rejects.toThrow()
  await until(() => (alive(pid!) ? undefined : true))
})

test('a claude that is not logged in fails the translation as NOT_AUTHENTICATED and is not left running', async () => {
  const { client, records } = start('not-logged-in')

  await expect(client.translateSegments(INPUT)).rejects.toMatchObject({
    code: 'NOT_AUTHENTICATED',
    status: 401,
  })
  const [pid] = userPids(records())
  await until(() => (alive(pid!) ? undefined : true))
})

test('a claude that exits at once fails the translation as AGENT_FAILED with the end of its stderr', async () => {
  const { client } = start('exit-at-start')

  await expect(client.translateSegments(INPUT)).rejects.toMatchObject({
    code: 'AGENT_FAILED',
    data: { detail: expect.stringContaining('claude: the config is broken') },
  })
})
