import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import * as defuddle from 'defuddle/node'

import type { AskInput, ChatEvent } from './contract.ts'
import { testPdf } from './page/test-pdf.ts'
import { createChatAgent, router } from './server.ts'
import { writeFakeClaude } from './testing.ts'

type Block =
  | { type: 'text'; text: string }
  | {
      type: 'document'
      source: { type: 'text'; media_type: 'text/plain'; data: string }
      title?: string
      context: string
    }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }

type Record =
  | { pid: number; kind: 'start'; argv: string[]; env: { [key: string]: string }; cwd: string }
  | { pid: number; kind: 'initialize'; request: { [key: string]: unknown } }
  | { pid: number; kind: 'user'; content: Block[] }
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
  const claudePath = writeFakeClaude(home, recordPath)
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

const MATH_HTML =
  '<head><title>Math</title></head><body><nav>Home</nav><article><p>One and one make two, and two and two make four.</p></article></body>'

const QUESTION: AskInput = {
  question: 'What is 1+1?',
  page: {
    url: 'https://example.com/math',
    title: 'Math',
    content: { kind: 'html', html: MATH_HTML },
  },
  history: [],
}

test('ask sends the Page Snapshot first, then streams the text deltas of claude in order and closes after the result, leaving out the thinking', async () => {
  const { client } = startChat()

  const events = []
  for await (const event of await client.ask(QUESTION)) events.push(event)

  expect(events).toEqual([
    {
      type: 'snapshot',
      page: {
        url: 'https://example.com/math',
        title: 'Math',
        content: {
          kind: 'text',
          source: 'html',
          text: 'One and one make two, and two and two make four.',
          truncated: false,
        },
      },
      omitted: { pages: 0, turns: 0 },
    },
    { type: 'text', text: 'Two' },
    { type: 'text', text: ' is' },
    { type: 'text', text: ' the answer.' },
  ])
})

async function answerOf(answer: AsyncIterable<ChatEvent>): Promise<string> {
  let text = ''
  for await (const event of answer) if (event.type === 'text') text += event.text
  return text
}

const userContent = (records: Record[]) =>
  records.filter((r) => r.kind === 'user').flatMap(({ content }) => content)

test('claude reads the text of the page as a document, apart from the question', async () => {
  const { client, records } = startChat()

  await answerOf(await client.ask(QUESTION))

  expect(userContent(records())).toEqual([
    {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'One and one make two, and two and two make four.',
      },
      title: 'Math',
      context: 'URL: https://example.com/math',
    },
    { type: 'text', text: expect.stringContaining('What is 1+1?') },
  ])
})

const SCREENSHOT = 'c2NyZWVuc2hvdA=='

test('claude sees the screenshot as an image next to the document of its page, and the snapshot does not send it back', async () => {
  const { client, records } = startChat()

  const [snapshot] = await Array.fromAsync(
    await client.ask({ ...QUESTION, page: { ...QUESTION.page, screenshot: SCREENSHOT } }),
  )

  expect(userContent(records()).map(({ type }) => type)).toEqual(['document', 'image', 'text'])
  expect(userContent(records())[1]).toEqual({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: SCREENSHOT },
  })
  expect(snapshot).toMatchObject({ type: 'snapshot', page: { title: 'Math' } })
  expect(snapshot).not.toHaveProperty('page.screenshot')
})

test('a screenshot that could not be taken leaves the text of the page to claude, and the snapshot keeps the reason', async () => {
  const { client, records } = startChat()
  const screenshotFailed = { reason: 'Cannot access contents of the page' }

  const [snapshot] = await Array.fromAsync(
    await client.ask({ ...QUESTION, page: { ...QUESTION.page, screenshotFailed } }),
  )

  expect(snapshot).toMatchObject({ type: 'snapshot', page: { screenshotFailed } })
  expect(userContent(records()).map(({ type }) => type)).toEqual(['document', 'text'])
  expect(userText(records())).toContain('could not be taken: Cannot access contents of the page')
})

test('a page whose HTML could not be turned into text is still answered, after a snapshot that says so', async () => {
  const failing = spyOn(defuddle, 'Defuddle').mockRejectedValue(new Error('the parser broke'))
  cleanups.push(() => failing.mockRestore())
  const { client, records } = startChat()

  const events = []
  for await (const event of await client.ask(QUESTION)) events.push(event)

  expect(events[0]).toEqual({
    type: 'snapshot',
    page: {
      url: 'https://example.com/math',
      title: 'Math',
      content: { kind: 'unreadable', reason: 'unparsable', detail: 'the parser broke' },
    },
    omitted: { pages: 0, turns: 0 },
  })
  expect(events.slice(1).map((event) => event.type)).toEqual(['text', 'text', 'text'])
  expect(userContent(records()).map(({ type }) => type)).toEqual(['text'])
})

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
  userContent(records)
    .map((block) => (block.type === 'text' ? block.text : `[document] ${block.source.data}`))
    .join('\n')

test('claude reads each earlier turn with its page text and answer, then the current page and the question', async () => {
  const { client, records } = startChat()

  await answerOf(
    await client.ask({
      ...QUESTION,
      question: 'And what does it say about four?',
      history: [
        {
          question: 'What is this page about?',
          page: {
            url: 'https://example.com/addition',
            title: 'Addition',
            content: {
              kind: 'text',
              source: 'html',
              text: 'Carrying moves a ten to the next column.',
              truncated: false,
            },
          },
          answer: 'It explains carrying.',
        },
      ],
    }),
  )

  expect(userText(records())).toMatch(
    /\[document\] Carrying moves a ten[\s\S]*https:\/\/example\.com\/addition[\s\S]*What is this page about\?[\s\S]*It explains carrying\.[\s\S]*\[document\] One and one make two[\s\S]*https:\/\/example\.com\/math[\s\S]*And what does it say about four\?/,
  )
})

test('a question on the page of an earlier turn gets a snapshot that points at that turn, and claude does not read the text twice', async () => {
  const { client, records } = startChat()
  const [first] = await Array.fromAsync(await client.ask(QUESTION))
  if (first?.type !== 'snapshot') throw new Error('no snapshot')

  const [second] = await Array.fromAsync(
    await client.ask({
      ...QUESTION,
      question: 'And 2+2?',
      history: [{ question: QUESTION.question, page: first.page, answer: 'Two is the answer.' }],
    }),
  )

  expect(second).toMatchObject({ type: 'snapshot', page: { content: { kind: 'same', turn: 0 } } })
  const [, secondAsk] = records().filter((r) => r.kind === 'user')
  if (secondAsk?.kind !== 'user') throw new Error('no second question')
  expect(secondAsk.content.filter(({ type }) => type === 'document')).toHaveLength(1)
})

const pdfQuestion = (question: string): AskInput => ({
  question,
  page: {
    url: 'https://example.com/tides.pdf',
    content: {
      kind: 'pdf',
      pdf: new File([testPdf([{ font: 'japanese', lines: ['合言葉は桜餅です'] }])], 'tides.pdf'),
    },
  },
  history: [],
})

test('a question on a PDF gets a snapshot of the text of the PDF, and the same PDF asked again points at that turn', async () => {
  const { client, records } = startChat()

  const [first] = await Array.fromAsync(await client.ask(pdfQuestion('この PDF の合言葉は？')))
  if (first?.type !== 'snapshot') throw new Error('no snapshot')
  const [second] = await Array.fromAsync(
    await client.ask({
      ...pdfQuestion('もう一度'),
      history: [{ question: 'この PDF の合言葉は？', page: first.page, answer: '桜餅です。' }],
    }),
  )

  expect(first.page.content).toEqual({
    kind: 'text',
    source: 'pdf',
    text: '合言葉は桜餅です',
    truncated: false,
  })
  expect(second).toMatchObject({ type: 'snapshot', page: { content: { kind: 'same', turn: 0 } } })
  const [firstAsk] = records().filter((r) => r.kind === 'user')
  if (firstAsk?.kind !== 'user') throw new Error('no question')
  expect(firstAsk.content[0]).toMatchObject({
    type: 'document',
    source: { data: '合言葉は桜餅です' },
    context: expect.stringContaining('extracted from a PDF'),
  })
})

// chrome:// の Browser Tab では side panel から URL と title が見えず、読めない。
test('a question about a page that could not be read is answered too, and its snapshot keeps the reason', async () => {
  const { client } = startChat()
  const unreadable = {
    kind: 'unreadable',
    reason: 'restricted',
    detail: 'Cannot access a chrome:// URL',
  } as const

  const events = await Array.fromAsync(
    await client.ask({ question: 'What is 1+1?', page: { content: unreadable }, history: [] }),
  )

  expect(events[0]).toEqual({
    type: 'snapshot',
    page: { content: unreadable },
    omitted: { pages: 0, turns: 0 },
  })
  expect(events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('')).toBe(
    'Two is the answer.',
  )
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
    for await (const event of answer) if (event.type === 'text') controller.abort()
  } catch {
    // 止めた答えは error で終わる。
  }

  const [pid] = answeringPids(records())
  await gone(pid!)
})

test('leaving the answer before the result kills the claude that answers', async () => {
  const { client, records } = startChat()

  for await (const event of await client.ask(HELD)) if (event.type === 'text') break

  const [pid] = answeringPids(records())
  await gone(pid!)
})

type Client = ReturnType<typeof startChat>['client']

// 答えの途中で止まった claude を n 個持たせる。
async function holdAnswers(client: Client, records: () => Record[], n: number) {
  const before = answeringPids(records()).length
  for (let i = 0; i < n; i++) {
    const answer = await client.ask(HELD)
    // snapshot の後の最初の text まで読む。後片付けで SIGKILL した答えは error で終わる。
    answer
      .next()
      .then(() => answer.next())
      .catch(() => {})
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
    for await (const event of await client.ask(HELD, { signal: controller.signal })) {
      if (event.type === 'text') controller.abort()
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
