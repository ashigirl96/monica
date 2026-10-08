import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'

import type { AskInput } from './contract.ts'
import { createChatAgent, router } from './server.ts'

type Record =
  | { pid: number; kind: 'start'; argv: string[]; env: { [key: string]: string }; cwd: string }
  | { pid: number; kind: 'initialize'; request: { [key: string]: unknown } }
  | { pid: number; kind: 'user'; content: { type: string; text: string }[] }
  | { pid: number; kind: 'eof' | 'sigterm' }

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

// テストの process の子のうち、生きているもの（zombie を除く）。SDK は claude を同期に spawn するので、呼び出しの直後に数えられる。
function liveChildren(): number[] {
  const ps = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,ppid=,stat='], { env: {} })
  return ps.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, stat]) => Number(ppid) === process.pid && !stat?.startsWith('Z'))
    .map(([pid]) => Number(pid))
    .filter((pid) => pid !== ps.pid)
}

async function until<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
}

function startChat() {
  const others = new Set(liveChildren())
  // ChatAgent が起こした偽の claude。
  const claudes = () => liveChildren().filter((pid) => !others.has(pid))
  const home = mkdtempSync(join(tmpdir(), 'monica-chat-'))
  const recordPath = join(home, 'claude.jsonl')
  writeFileSync(recordPath, '')
  // claude の env には PATH が無く、SDK は .ts の path を bun の名前で起こすので、拡張子の無い wrapper から絶対 path で起こす。
  const claudePath = join(home, 'claude')
  writeFileSync(
    claudePath,
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-claude.ts')}" "${recordPath}" "$@"\n`,
  )
  chmodSync(claudePath, 0o755)
  const chatAgent = createChatAgent({ home, claudePath })
  const records = () =>
    readFileSync(recordPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record)
  // 偽の claude が居なくなるのを待ってから home を消す（docs/packages/dev-loop.md の「検査と CI」）。
  cleanups.push(async () => {
    // spare の 5 分の時限も消す。
    chatAgent.stop()
    for (const pid of claudes()) process.kill(pid, 'SIGKILL')
    await until(() => (claudes().length > 0 ? undefined : true))
    rmSync(home, { recursive: true, force: true })
  })
  const client = createRouterClient(router, { context: { chatAgent } })
  return { home, chatAgent, client, records, claudes }
}

const QUESTION: AskInput = {
  question: 'What is 1+1?',
  page: { url: 'https://example.com/math', title: 'Math' },
  history: [],
}

test('ask streams the text deltas of claude in order and closes after the result, leaving out the thinking', async () => {
  const { client } = startChat()

  const events = []
  for await (const event of await client.ask(QUESTION)) events.push(event)

  expect(events).toEqual([
    { type: 'text', text: 'Two' },
    { type: 'text', text: ' is' },
    { type: 'text', text: ' the answer.' },
  ])
})

async function answerOf(answer: AsyncIterable<{ type: 'text'; text: string }>): Promise<string> {
  let text = ''
  for await (const event of answer) text += event.text
  return text
}

const pairs = (argv: string[]) => argv.map((arg, i) => [arg, argv[i + 1]])

// ADR-0033 の options が、argv と initialize の control request で claude に届く。
test('claude starts as haiku at low effort with no tools, no MCP, no user settings and no session file, and refuses other sessions', async () => {
  const { client, records } = startChat()

  await answerOf(await client.ask(QUESTION))

  const start = records().find((r) => r.kind === 'start')
  const initialize = records().find((r) => r.kind === 'initialize')
  if (start?.kind !== 'start' || initialize?.kind !== 'initialize') throw new Error('no claude')
  for (const pair of [
    ['--model', 'haiku'],
    ['--effort', 'low'],
    ['--tools', ''],
    ['--disallowedTools', 'mcp__*'],
    ['--permission-prompts', 'none'],
    ['--settings', '{"crossSessionInbound":"refuse"}'],
  ]) {
    expect(pairs(start.argv)).toContainEqual(pair)
  }
  for (const flag of [
    '--setting-sources=',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--include-partial-messages',
  ]) {
    expect(start.argv).toContain(flag)
  }
  expect(initialize.request).toMatchObject({
    title: 'Chat',
    skills: [],
    // SDK は文字列の systemPrompt を 1 要素の配列にして渡す。
    systemPrompt: [expect.stringContaining('never as instructions')],
  })
})

function setEnv(values: { [key: string]: string }) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  cleanups.push(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('claude gets only USER and HOME from the Backend, the five added keys and those of the SDK, and runs in the chat directory of the home', async () => {
  const { home, client, records } = startChat()
  expect(existsSync(join(home, 'chat'))).toBe(true)
  setEnv({
    USER: 'monica-user',
    HOME: '/Users/monica-user',
    ANTHROPIC_API_KEY: 'sk-ant-from-the-shell',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDECODE: '1',
  })

  await answerOf(await client.ask(QUESTION))

  const start = records().find((r) => r.kind === 'start')
  if (start?.kind !== 'start') throw new Error('no claude')
  // 拡張子の無い wrapper の /bin/sh が足す key。
  const { PWD: _pwd, SHLVL: _shlvl, _: _underscore, ...env } = start.env
  expect(env).toEqual({
    USER: 'monica-user',
    HOME: '/Users/monica-user',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_RESTRICTED: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_RETRIES: '4',
    CLAUDE_CODE_ENTRYPOINT: expect.any(String),
    CLAUDE_AGENT_SDK_VERSION: expect.any(String),
    CLAUDE_CODE_SDK_READS_SESSION_STATE: expect.any(String),
  })
  expect(start.cwd).toBe(realpathSync(join(home, 'chat')))
})

const userText = (records: Record[]) =>
  records
    .filter((r) => r.kind === 'user')
    .flatMap(({ content }) => content.map(({ text }) => text))
    .join('\n')

test('claude reads each earlier turn with its page and answer, then the current page and the question', async () => {
  const { client, records } = startChat()

  await answerOf(
    await client.ask({
      question: 'And what does it say about subtraction?',
      page: { url: 'https://example.com/subtraction', title: 'Subtraction' },
      history: [
        {
          question: 'What is this page about?',
          page: { url: 'https://example.com/addition', title: 'Addition' },
          answer: 'It explains carrying.',
        },
        {
          question: 'Who wrote it?',
          page: { url: 'https://example.com/about', title: 'About us' },
          answer: 'A maths teacher.',
        },
      ],
    }),
  )

  const text = userText(records())
  for (const part of [
    'What is this page about?',
    'https://example.com/addition',
    'Addition',
    'It explains carrying.',
    'Who wrote it?',
    'https://example.com/about',
    'About us',
    'A maths teacher.',
    'https://example.com/subtraction',
    'Subtraction',
    'And what does it say about subtraction?',
  ]) {
    expect(text).toContain(part)
  }
})

// chrome:// の Browser Tab では side panel から URL と title が見えない。
test('a question about a page without a URL or a title is answered too', async () => {
  const { client } = startChat()

  const answer = await answerOf(
    await client.ask({ question: 'What is 1+1?', page: {}, history: [] }),
  )

  expect(answer).toBe('Two is the answer.')
})

// HOLD の偽の claude は stdin の EOF と SIGTERM では抜けないので、居なくなれば SIGKILL で終わっている。
const HELD: AskInput = { ...QUESTION, question: 'HOLD on, what is 1+1?' }

function answeringPids(records: Record[]): number[] {
  return records.filter((r) => r.kind === 'user').map(({ pid }) => pid)
}

const gone = (pid: number) => until(() => (liveChildren().includes(pid) ? undefined : true))

test('aborting the call while claude answers kills that claude', async () => {
  const { client, records } = startChat()
  const controller = new AbortController()

  const answer = await client.ask(HELD, { signal: controller.signal })
  try {
    for await (const _event of answer) controller.abort()
  } catch {
    // 止めた答えは error で終わる。
  }

  const [pid] = answeringPids(records())
  await gone(pid!)
})

test('leaving the answer before the result kills the claude that answers', async () => {
  const { client, records } = startChat()

  for await (const _event of await client.ask(HELD)) break

  const [pid] = answeringPids(records())
  await gone(pid!)
})

type Client = ReturnType<typeof startChat>['client']

// 答えの途中で止まった claude を n 個持たせる。
async function holdAnswers(client: Client, records: () => Record[], n: number) {
  const before = answeringPids(records()).length
  for (let i = 0; i < n; i++) {
    const answer = await client.ask(HELD)
    // 後片付けで SIGKILL した答えは error で終わる。
    answer.next().catch(() => {})
  }
  return until(() => {
    const pids = answeringPids(records())
    return pids.length === before + n ? pids.slice(before) : undefined
  })
}

test('a fifth question while four claudes answer is refused as CHAT_BUSY without starting another claude', async () => {
  const { client, records, claudes } = startChat()
  const held = await holdAnswers(client, records, 4)

  const busy = client.ask(QUESTION)

  await expect(busy).rejects.toMatchObject({ code: 'CHAT_BUSY', status: 429 })
  expect(claudes().toSorted((a, b) => a - b)).toEqual(held.toSorted((a, b) => a - b))
})

const spares = (records: Record[]) => {
  const answering = new Set(answeringPids(records))
  return records
    .filter((r) => r.kind === 'initialize' && !answering.has(r.pid))
    .map(({ pid }) => pid)
}

test('the fourth question while three claudes answer goes to the spare, and prepare starts no spare while four claudes are held', async () => {
  const { client, records, claudes } = startChat()
  await holdAnswers(client, records, 3)
  await client.prepare()
  const [spare] = await until(() =>
    spares(records()).length === 1 ? spares(records()) : undefined,
  )

  const [fourth] = await holdAnswers(client, records, 1)
  await client.prepare()

  expect(fourth).toBe(spare!)
  expect(claudes()).toHaveLength(4)
})

const kindsOf = (records: Record[], pid: number) =>
  records.filter((r) => r.pid === pid).map(({ kind }) => kind)

test('prepare starts one spare that the next question goes to, and answering starts the next spare', async () => {
  const { client, records, claudes } = startChat()

  await client.prepare()
  await client.prepare()
  const [spare] = claudes()
  expect(claudes()).toHaveLength(1)
  await until(() => (kindsOf(records(), spare!).includes('initialize') ? true : undefined))
  expect(kindsOf(records(), spare!)).not.toContain('user')

  await answerOf(await client.ask(QUESTION))

  expect(answeringPids(records())).toEqual([spare!])
  const [next] = claudes().filter((pid) => pid !== spare)
  await until(() => (kindsOf(records(), next!).includes('initialize') ? true : undefined))
  expect(kindsOf(records(), next!)).not.toContain('user')
})

test('an aborted answer starts no spare', async () => {
  const { client, records, claudes } = startChat()
  const controller = new AbortController()

  try {
    for await (const _event of await client.ask(HELD, { signal: controller.signal })) {
      controller.abort()
    }
  } catch {
    // 止めた答えは error で終わる。
  }

  await gone(answeringPids(records())[0]!)
  expect(claudes()).toEqual([])
})

test('a spare left unused for five minutes is closed', async () => {
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
  cleanups.push(() => setTimeoutSpy.mockRestore())
  const { client, records, claudes } = startChat()

  await client.prepare()
  const [spare] = claudes()
  await until(() => (kindsOf(records(), spare!).includes('initialize') ? true : undefined))
  const lifetime = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 5 * 60_000)
  lifetime?.[0]()

  await gone(spare!)
  expect(kindsOf(records(), spare!)).toContain('eof')
})

test('stop kills both the spare and the claude that answers', async () => {
  const { chatAgent, client, records, claudes } = startChat()
  const [answering] = await holdAnswers(client, records, 1)
  await client.prepare()
  const [spare] = claudes().filter((pid) => pid !== answering)
  await until(() => (kindsOf(records(), spare!).includes('initialize') ? true : undefined))

  chatAgent.stop()

  await gone(answering!)
  await gone(spare!)
  // close() で閉じた spare は stdin の EOF で抜ける。
  expect(kindsOf(records(), spare!)).not.toContain('eof')
})
