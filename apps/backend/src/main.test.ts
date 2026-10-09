import { afterEach, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type contract as chatContract, MAX_ASK_BODY_BYTES } from '@monica/chat/contract'
import { type FakeScenario, untilFakeClaudesExit, writeFakeClaude } from '@monica/chat/testing'
import { startFakePtyd, tempHome } from '@monica/workbench/testing'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

import { freePort } from './testing.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

type Announcement =
  | { type: 'endpoint'; port: number; token: string }
  | { type: 'notify'; title: string; body: string; terminalSessionId: string }
  | { type: 'unread'; terminalSessionIds: string[] }

function announcements(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  return async function next(): Promise<Announcement> {
    for (;;) {
      const newline = text.indexOf('\n')
      if (newline >= 0) {
        const line = text.slice(0, newline)
        text = text.slice(newline + 1)
        return JSON.parse(line) as Announcement
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('the Backend exited')
      text += decoder.decode(value, { stream: true })
    }
  }
}

type Env = { [key: string]: string | undefined }

// main.ts は Backend の組み立てそのものなので、Shell と同じく process として起こす。
async function startBackend(browserPort: number, envOf: (home: string) => Env = () => ({})) {
  const home = tempHome((cleanup) => cleanups.push(cleanup))
  const ptyd = startFakePtyd(home)
  cleanups.push(() => ptyd.stop())
  const { MONICA_BROWSER_PORT: _, MONICA_CLAUDE_PATH: __, ...inherited } = process.env
  const backend = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: {
      ...inherited,
      MONICA_HOME: home,
      MONICA_PTYD_PATH: join(home, 'no-ptyd'),
      MONICA_BROWSER_PORT: String(browserPort),
      // login shell の rc を読む時間を短くする。
      SHELL: '/bin/sh',
      ...envOf(home),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  // Backend が exit で消す backend.json や、偽の claude と競うと、Bun の rmSync は黙って止まり home を残す。
  // Backend は exit で claude に SIGKILL を送るだけで、居なくなるのを待たない。
  cleanups.push(async () => {
    backend.kill()
    await backend.exited
    await untilFakeClaudesExit(home)
  })
  const next = announcements(backend.stdout)
  const beforeEndpoint: Announcement[] = []
  for (;;) {
    const line = await next()
    if (line.type === 'endpoint')
      return { home, port: line.port, token: line.token, beforeEndpoint, next }
    beforeEndpoint.push(line)
  }
}

type Backend = Awaited<ReturnType<typeof startBackend>>

function endpointFile(home: string): { port: number; token: string; chatToken: string } {
  return JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8'))
}

function viaToken(
  { port, token }: { port: number; token?: string },
  path: string,
  input: object = {},
) {
  return fetch(`http://127.0.0.1:${port}/rpc/${path}`, {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json: input }),
  })
}

/** Chrome Extension と同じく、backend.json の chat の token で token の口を呼ぶ。 */
function chatClient(backend: Backend): ContractRouterClient<{ chat: typeof chatContract }> {
  return createORPCClient(
    new RPCLink({
      url: `http://127.0.0.1:${backend.port}/rpc`,
      headers: { authorization: `Bearer ${endpointFile(backend.home).chatToken}` },
    }),
  )
}

const fakeClaude = (scenario: FakeScenario) => (home: string) => ({
  MONICA_CLAUDE_PATH: writeFakeClaude(home, join(home, 'claude.jsonl'), scenario),
  // node_modules の claude を起こしてしまっても、keychain の login を読めずに本物の API を呼ばない。
  USER: undefined,
})

// 不正な input の chat.ask は handler の前で 400 で断られるので、claude を起こさずに口に載っているかを見られる。
const INVALID_QUESTION = { question: '' }

test('the token listener carries workbench, task, job and chat but not note, and the browser listener note but none of those four', async () => {
  const browserPort = freePort()
  const backend = await startBackend(browserPort)

  // 19380 を他の process が先に握っても Current Page を渡さないよう、Chrome Extension の fetch が通る組でも chat は無い。
  const viaBrowser = (path: string, input: object = {}) =>
    fetch(`http://127.0.0.1:${browserPort}/rpc/${path}`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${browserPort}`,
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'cors',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ json: input }),
    })

  for (const path of ['workbench/layout/get', 'task/list', 'job/list']) {
    expect([path, (await viaToken(backend, path)).status]).toEqual([path, 200])
    expect([path, (await viaBrowser(path)).status]).toEqual([path, 404])
  }
  expect((await viaToken(backend, 'chat/ask', INVALID_QUESTION)).status).toBe(400)
  expect((await viaBrowser('chat/ask', INVALID_QUESTION)).status).toBe(404)
  expect((await viaBrowser('note/essay/create')).status).toBe(200)
  expect((await viaToken(backend, 'note/essay/create')).status).toBe(404)
}, 20_000)

// Chrome Extension の side panel で script が動いても、shell に打鍵する workbench.openTab には届かせない（ADR-0017・0034）。
test('the chat token in backend.json opens only chat on the token listener, the full token opens everything, and no token opens nothing', async () => {
  const backend = await startBackend(freePort())
  const endpoint = endpointFile(backend.home)
  const viaChatToken = { port: backend.port, token: endpoint.chatToken }

  expect(statSync(join(backend.home, 'backend.json')).mode & 0o777).toBe(0o600)
  expect(endpoint).toMatchObject({ port: backend.port, token: backend.token })
  expect(endpoint.chatToken).toEqual(expect.any(String))
  expect(endpoint.chatToken).not.toBe(backend.token)

  expect((await viaToken(viaChatToken, 'chat/ask', INVALID_QUESTION)).status).toBe(400)
  expect((await viaToken({ port: backend.port }, 'chat/ask', INVALID_QUESTION)).status).toBe(401)
  for (const path of ['workbench/layout/get', 'task/list', 'job/list']) {
    expect([path, (await viaToken(viaChatToken, path)).status]).toEqual([path, 401])
    expect([path, (await viaToken({ port: backend.port }, path)).status]).toEqual([path, 401])
    expect([path, (await viaToken(backend, path)).status]).toEqual([path, 200])
  }
}, 20_000)

test('the Backend answers chat.ask with the claude that MONICA_CLAUDE_PATH names', async () => {
  const backend = await startBackend(freePort(), fakeClaude('answer'))

  let answer = ''
  for await (const event of await chatClient(backend).chat.ask({
    question: 'What is 1 + 1?',
    page: { content: { kind: 'unreadable', reason: 'restricted' } },
    history: [],
  }))
    if (event.type === 'text') answer += event.text

  expect(answer).toBe('Two is the answer.')
}, 20_000)

// 1 つの質問に添えるページの本文とスクリーンショットを受けられる上限で、それを超える body は読まずに断る。
test('a body larger than the limit for a question is refused with 413', async () => {
  const backend = await startBackend(freePort())
  const { chatToken } = endpointFile(backend.home)

  const ask = (bytes: number) =>
    fetch(`http://127.0.0.1:${backend.port}/rpc/chat/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${chatToken}`, 'content-type': 'application/json' },
      body: new Uint8Array(bytes),
    })

  expect((await ask(MAX_ASK_BODY_BYTES + 1)).status).toBe(413)
  // 上限の内側の壊れた body は oRPC まで届く。
  expect((await ask(1024)).status).toBe(400)
}, 20_000)

// side panel は body が上限から 1MiB の余白を残すまで PDF を送る。RPCLink は File を multipart の別の part で送る。
test('a PDF 1MiB under the body limit goes through RPCLink to chat.ask, and bytes that are no PDF come back as unparsable', async () => {
  const backend = await startBackend(freePort(), fakeClaude('answer'))
  const pdf = new File(['%PDF-', new Uint8Array(MAX_ASK_BODY_BYTES - 1024 * 1024 - 5)], 'big.pdf', {
    type: 'application/pdf',
  })

  const answer = await chatClient(backend).chat.ask({
    question: 'What does it say?',
    page: { url: 'https://example.com/big.pdf', content: { kind: 'pdf', pdf } },
    history: [],
  })
  const { value: snapshot } = await answer.next()
  await answer.return(undefined)

  expect(snapshot).toMatchObject({
    type: 'snapshot',
    page: { content: { kind: 'unreadable', reason: 'unparsable' } },
  })
}, 20_000)

// 答えの途中の失敗は、流した text の後に、宣言した error の code と data で Chrome Extension に届く。
test('a failure after some text of the answer reaches an RPCLink client after that text as the declared error with its data', async () => {
  const backend = await startBackend(freePort(), fakeClaude('max-output-tokens'))
  const texts: string[] = []

  const failing = (async () => {
    for await (const event of await chatClient(backend).chat.ask({
      question: 'What is 1+1?',
      page: { content: { kind: 'unreadable', reason: 'restricted' } },
      history: [],
    })) {
      if (event.type === 'text') texts.push(event.text)
    }
  })()

  const error = await failing.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(texts).toEqual(['Two', ' is'])
  expect(error).toBeInstanceOf(ORPCError)
  expect(error).toMatchObject({
    code: 'AGENT_FAILED',
    status: 500,
    defined: true,
    data: { detail: expect.stringContaining('output token maximum') },
  })
}, 20_000)

// 新しい Tab の claude が turn を終え、手空きの通知が出る。
async function waitInANewTab(backend: Awaited<ReturnType<typeof startBackend>>) {
  const created = await viaToken(backend, 'workbench/runspace/create', { rows: 24, cols: 80 })
  const { json } = (await created.json()) as { json: { tab: { terminalSessionId: string } } }
  await viaToken(backend, 'workbench/agentSession/recordHook', {
    terminalSessionId: json.tab.terminalSessionId,
    payload: {
      session_id: 's-1',
      transcript_path: '/t.jsonl',
      cwd: '/work',
      hook_event_name: 'Stop',
    },
  })
  return json.tab.terminalSessionId
}

async function nextOf(
  backend: Awaited<ReturnType<typeof startBackend>>,
  type: Announcement['type'],
): Promise<Announcement> {
  let line = await backend.next()
  while (line.type !== type) line = await backend.next()
  return line
}

test('the Backend tells the Shell the unread Terminal Sessions before its endpoint and again when a notified wait adds one', async () => {
  const backend = await startBackend(freePort())

  const terminalSessionId = await waitInANewTab(backend)

  expect(backend.beforeEndpoint).toEqual([{ type: 'unread', terminalSessionIds: [] }])
  expect(await nextOf(backend, 'unread')).toEqual({
    type: 'unread',
    terminalSessionIds: [terminalSessionId],
  })
}, 20_000)

test('the Backend tells the Shell to post a notification that carries the Terminal Session of the wait', async () => {
  const backend = await startBackend(freePort())

  const terminalSessionId = await waitInANewTab(backend)

  expect(await nextOf(backend, 'notify')).toMatchObject({ type: 'notify', terminalSessionId })
}, 20_000)

test('the Backend hands the Job Ledger the system Jobs of task and note', async () => {
  const response = await viaToken(await startBackend(freePort()), 'job/list')
  const { json } = (await response.json()) as { json: { jobs: { name: string }[] } }

  expect(json.jobs.map(({ name }) => name)).toEqual([
    'task.sync',
    'task.setup-log-cleanup',
    'note.image-cleanup',
  ])
}, 20_000)
