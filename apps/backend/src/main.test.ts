import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type contract as chatContract, MAX_ASK_BODY_BYTES } from '@monica/chat/contract'
import {
  type FakeScenario,
  testPdf,
  untilFakeClaudesExit,
  writeFakeClaude,
} from '@monica/chat/testing'
import { startFakePtyd, tempHome, writeFakeExecutable } from '@monica/workbench/testing'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

import { freePort } from './testing.ts'

// 負荷の下では `bun main.ts` の起動が既定の 5 秒を越えることがある。
setDefaultTimeout(20_000)

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

type FakePtyd = ReturnType<typeof startFakePtyd>

type SpawnOptions = {
  beforeSpawn?: (ptyd: FakePtyd) => void
  sharing?: { home: string; ptyd: FakePtyd }
}

function stderrOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return (async () => {
    let text = ''
    const decoder = new TextDecoder()
    for await (const bytes of stream) {
      const chunk = decoder.decode(bytes, { stream: true })
      process.stderr.write(chunk)
      text += chunk
    }
    return text
  })()
}

// main.ts は Backend の組み立てそのものなので、Shell と同じく process として起こす。
function spawnBackend(
  browserPort: number,
  envOf: (home: string) => Env = () => ({}),
  { beforeSpawn, sharing }: SpawnOptions = {},
) {
  const home = sharing?.home ?? tempHome((cleanup) => cleanups.push(cleanup))
  let ptyd = sharing?.ptyd
  if (!ptyd) {
    const started = startFakePtyd(home)
    cleanups.push(() => started.stop())
    ptyd = started
  }
  beforeSpawn?.(ptyd)
  const { MONICA_BROWSER_PORT: _, MONICA_CLAUDE_PATH: __, ...inherited } = process.env
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
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
    stderr: 'pipe',
  })
  // Backend が exit で消す backend.json や、偽の claude と競うと、Bun の rmSync は黙って止まり home を残す。
  // Backend は exit で claude に SIGKILL を送るだけで、居なくなるのを待たない。
  cleanups.push(async () => {
    subprocess.kill()
    await subprocess.exited
    await untilFakeClaudesExit(home)
  })
  const stderr = stderrOf(subprocess.stderr)
  const next = announcements(subprocess.stdout)
  const beforeEndpoint: Announcement[] = []
  async function endpoint() {
    for (;;) {
      const line = await next()
      if (line.type === 'endpoint') return line
      beforeEndpoint.push(line)
    }
  }
  return { home, ptyd, subprocess, stderr, next, beforeEndpoint, endpoint }
}

async function startBackend(
  browserPort: number,
  envOf: (home: string) => Env = () => ({}),
  options: SpawnOptions = {},
) {
  const spawned = spawnBackend(browserPort, envOf, options)
  const announced = await spawned.endpoint()
  return { ...spawned, port: announced.port, token: announced.token, announced }
}

type Backend = Awaited<ReturnType<typeof startBackend>>

function endpointFile(home: string): { port: number; token: string; extensionToken: string } {
  return JSON.parse(readFileSync(join(home, 'backend.json'), 'utf8'))
}

function viaToken(
  { port, token }: { port: number; token?: string },
  path: string,
  input: object = {},
  headers: Record<string, string> = {},
) {
  return fetch(`http://127.0.0.1:${port}/rpc/${path}`, {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ json: input }),
  })
}

/** Chrome Extension と同じく、backend.json の Chrome Extension の token で token の口を呼ぶ。 */
function chatClient(backend: Backend): ContractRouterClient<{ chat: typeof chatContract }> {
  return createORPCClient(
    new RPCLink({
      url: `http://127.0.0.1:${backend.port}/rpc`,
      headers: { authorization: `Bearer ${endpointFile(backend.home).extensionToken}` },
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
})

// Chrome Extension で script が動いても、任意の prompt を打つ task.run や shell に打鍵する workbench.openTab には届かせない（ADR-0017・0034・0035）。
test('the Chrome Extension token in backend.json opens only chat and the Run Button procedures of task on the token listener, the full token opens everything, and no token opens nothing', async () => {
  const backend = await startBackend(freePort())
  const endpoint = endpointFile(backend.home)
  const viaExtensionToken = { port: backend.port, token: endpoint.extensionToken }

  expect(statSync(join(backend.home, 'backend.json')).mode & 0o777).toBe(0o600)
  expect(endpoint).toMatchObject({ port: backend.port, token: backend.token })
  expect(endpoint.extensionToken).toEqual(expect.any(String))
  expect(endpoint.extensionToken).not.toBe(backend.token)

  expect((await viaToken(viaExtensionToken, 'chat/ask', INVALID_QUESTION)).status).toBe(400)
  expect((await viaToken({ port: backend.port }, 'chat/ask', INVALID_QUESTION)).status).toBe(401)
  // 不正な input は handler の前で 400 になるので、本物の GitHub に届かずに口に載っているかを見られる。
  for (const path of ['task/runButtons', 'task/press']) {
    expect([path, (await viaToken(viaExtensionToken, path, { ref: 1, refs: 1 })).status]).toEqual([
      path,
      400,
    ])
    expect([path, (await viaToken({ port: backend.port }, path)).status]).toEqual([path, 401])
  }
  for (const path of ['task/runFromButton', 'task/reopenFromButton']) {
    expect([path, (await viaToken(viaExtensionToken, path)).status]).toEqual([path, 401])
  }
  expect((await viaToken(viaExtensionToken, 'task/run', { ref: '' })).status).toBe(401)
  expect((await viaToken(backend, 'task/run', { ref: 1 })).status).toBe(400)
  for (const path of ['workbench/layout/get', 'task/list', 'job/list']) {
    expect([path, (await viaToken(viaExtensionToken, path)).status]).toEqual([path, 401])
    expect([path, (await viaToken({ port: backend.port }, path)).status]).toEqual([path, 401])
    expect([path, (await viaToken(backend, path)).status]).toEqual([path, 200])
  }
})

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
})

// 1 つの質問に添えるページの本文とスクリーンショットを受けられる上限で、それを超える body は読まずに断る。
test('a body larger than the limit for a question is refused with 413', async () => {
  const backend = await startBackend(freePort())
  const { extensionToken } = endpointFile(backend.home)

  const ask = (bytes: number) =>
    fetch(`http://127.0.0.1:${backend.port}/rpc/chat/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${extensionToken}`, 'content-type': 'application/json' },
      body: new Uint8Array(bytes),
    })

  expect((await ask(MAX_ASK_BODY_BYTES + 1)).status).toBe(413)
  // 上限の内側の壊れた body は oRPC まで届く。
  expect((await ask(1024)).status).toBe(400)
})

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
})

test('a Backend that exits while Chat answers leaves no claude behind', async () => {
  const backend = await startBackend(freePort(), fakeClaude('linger-after-answer'))
  const ask = (question: string) =>
    chatClient(backend).chat.ask({
      question,
      page: { content: { kind: 'unreadable', reason: 'restricted' } },
      history: [],
    })
  for await (const _ of await ask('What is 1 + 1?'));
  const answer = await ask('HOLD on, what is 1 + 1?')
  let read = await answer.next()
  while (!read.done && read.value.type !== 'text') read = await answer.next()

  await backend.subprocess.stdin.end()
  await backend.subprocess.exited

  const exited = await Promise.race([
    untilFakeClaudesExit(backend.home).then(() => 'exited'),
    Bun.sleep(3000).then(() => 'left behind'),
  ])
  expect(exited).toBe('exited')
})

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
})

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
})

test('the Backend tells the Shell to post a notification that carries the Terminal Session of the wait', async () => {
  const backend = await startBackend(freePort())

  const terminalSessionId = await waitInANewTab(backend)

  expect(await nextOf(backend, 'notify')).toMatchObject({ type: 'notify', terminalSessionId })
})

test('the Backend hands the Job Ledger the system Jobs of task and note', async () => {
  const response = await viaToken(await startBackend(freePort()), 'job/list')
  const { json } = (await response.json()) as { json: { jobs: { name: string }[] } }

  expect(json.jobs.map(({ name }) => name)).toEqual([
    'task.sync',
    'task.setup-log-cleanup',
    'note.image-cleanup',
  ])
})

type UsageItem = {
  feature: string
  caller: string | null
  ok: number
  failed: number
  lastUsed: string | null
}

async function usages(backend: Backend): Promise<UsageItem[]> {
  const response = await viaToken(backend, 'usage/list')
  return ((await response.json()) as { json: { usages: UsageItem[] } }).json.usages
}

test('the token listener counts a call without Origin as cli, with Origin as webview, and with the Chrome Extension token as extension, failures apart', async () => {
  const backend = await startBackend(freePort())
  const viaExtensionToken = { port: backend.port, token: endpointFile(backend.home).extensionToken }

  expect((await viaToken(backend, 'job/list')).status).toBe(200)
  expect((await viaToken(backend, 'job/show', { name: 'task.synk' })).status).toBe(404)
  expect((await viaToken(backend, 'job/list', {}, { origin: 'tauri://localhost' })).status).toBe(
    200,
  )
  expect((await viaToken(viaExtensionToken, 'chat/ask', INVALID_QUESTION)).status).toBe(400)

  const counted = await usages(backend)
  expect(counted).toContainEqual(
    expect.objectContaining({ feature: 'job.list', caller: 'cli', ok: 1, failed: 0 }),
  )
  expect(counted).toContainEqual(
    expect.objectContaining({ feature: 'job.show', caller: 'cli', ok: 0, failed: 1 }),
  )
  expect(counted).toContainEqual(
    expect.objectContaining({ feature: 'job.list', caller: 'webview', ok: 1, failed: 0 }),
  )
  expect(counted).toContainEqual(
    expect.objectContaining({ feature: 'chat.ask', caller: 'extension', ok: 0, failed: 1 }),
  )
})

test('usage.list gives every Feature of both listeners as 0 calls, even when the Backend starts without the browser listener', async () => {
  const backend = await startBackend(freePort(), () => ({ MONICA_BROWSER_PORT: undefined }))

  const features = (await usages(backend)).map(({ feature }) => feature)

  for (const feature of ['workbench.layout.get', 'task.run', 'job.add', 'chat.ask', 'usage.list'])
    expect(features).toContain(feature)
  expect(await usages(backend)).toContainEqual({
    feature: 'note.daily.open',
    caller: null,
    ok: 0,
    failed: 0,
    lastUsed: null,
  })
})

async function tabPath(backend: Backend) {
  await viaToken(backend, 'workbench/runspace/create', { rows: 24, cols: 80 })
  const [create] = await backend.ptyd.receivedAtLeast(1, (op) => op.op === 'create')
  return create?.op === 'create' ? new Map(create.env ?? []).get('PATH') : undefined
}

async function stderrAfterExit(backend: { subprocess: Bun.Subprocess; stderr: Promise<string> }) {
  backend.subprocess.kill()
  await backend.subprocess.exited
  return (await backend.stderr).split('\n')
}

function fakeLoginShell(script: string) {
  return (home: string) => {
    const shell = join(home, 'zsh')
    writeFakeExecutable(shell, script)
    return { SHELL: shell }
  }
}

test('the Backend opens a Tab with the PATH its login shell prints, without handing that shell its stdin', async () => {
  const backend = await startBackend(
    freePort(),
    fakeLoginShell('read -r _\nPATH=/from/login/shell:/usr/bin:/bin /bin/sh -c "$2"'),
  )

  expect(await tabPath(backend)).toBe(`${backend.home}/bin:/from/login/shell:/usr/bin:/bin`)
})

test('a login shell that fails leaves the Backend on the PATH it started with, with one line on stderr', async () => {
  const failing = fakeLoginShell('echo broken >&2; exit 1')
  const backend = await startBackend(freePort(), (home) => ({
    ...failing(home),
    PATH: '/started/with:/usr/bin:/bin',
  }))

  expect(await tabPath(backend)).toBe(`${backend.home}/bin:/started/with:/usr/bin:/bin`)
  const lines = await stderrAfterExit(backend)
  expect(
    lines.filter((line) => line.includes('[backend] keeping the PATH it started with')),
  ).toEqual([expect.stringContaining('broken')])
})

test('the Backend without MONICA_PTYD_PATH exits 1 with one line on stderr and opens no DB', async () => {
  const home = tempHome((cleanup) => cleanups.push(cleanup))
  const {
    MONICA_PTYD_PATH: _,
    MONICA_BROWSER_PORT: __,
    MONICA_CLAUDE_PATH: ___,
    ...inherited
  } = process.env
  const backend = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { ...inherited, MONICA_HOME: home, SHELL: '/bin/sh' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect(await backend.exited).toBe(1)
  const stderr = await new Response(backend.stderr).text()
  expect(stderr.split('\n').filter((line) => line.includes('MONICA_PTYD_PATH'))).toHaveLength(1)
  expect(existsSync(join(home, 'monica.db'))).toBe(false)
})

type AskInput = Parameters<ReturnType<typeof chatClient>['chat']['ask']>[0]

async function askFails(backend: Backend, input: AskInput): Promise<unknown> {
  try {
    for await (const _ of await chatClient(backend).chat.ask(input));
  } catch (error) {
    return error
  }
  return undefined
}

test('a MONICA_CLAUDE_PATH that names no file leaves the Workbench answering and ends chat.ask as AGENT_FAILED', async () => {
  const backend = await startBackend(freePort(), (home) => ({
    MONICA_CLAUDE_PATH: join(home, 'no-claude'),
    USER: undefined,
  }))

  expect((await viaToken(backend, 'workbench/layout/get')).status).toBe(200)
  const error = await askFails(backend, {
    question: 'What is 1 + 1?',
    page: { content: { kind: 'unreadable', reason: 'restricted' } },
    history: [],
  })
  expect(error).toBeInstanceOf(ORPCError)
  expect(error).toMatchObject({ code: 'AGENT_FAILED' })
})

test('a second Backend on the same home exits non-zero while the first keeps answering', async () => {
  const first = await startBackend(freePort())

  const second = spawnBackend(freePort(), () => ({}), { sharing: first })
  const exitCode = await Promise.race([
    second.subprocess.exited,
    second.endpoint().then(
      () => 'announced',
      () => second.subprocess.exited,
    ),
  ])

  expect(exitCode).toEqual(expect.any(Number))
  expect(exitCode).not.toBe(0)
  expect((await viaToken(first, 'job/list')).status).toBe(200)
})

test('the Backend run from source reads a Japanese PDF and an HTML page into text for claude', async () => {
  const backend = await startBackend(freePort(), fakeClaude('answer'))
  const pdf = new File([testPdf([{ font: 'japanese', lines: ['合言葉は桜餅です'] }])], 'a.pdf', {
    type: 'application/pdf',
  })

  const snapshotOf = async (content: AskInput['page']['content']) => {
    const answer = await chatClient(backend).chat.ask({
      question: 'What does it say?',
      page: { url: 'https://example.com/page', content },
      history: [],
    })
    const { value } = await answer.next()
    await answer.return(undefined)
    return value
  }

  expect(await snapshotOf({ kind: 'pdf', pdf })).toMatchObject({
    type: 'snapshot',
    page: { content: { kind: 'text', text: expect.stringContaining('合言葉は桜餅です') } },
  })
  expect(
    await snapshotOf({
      kind: 'html',
      html: '<html><body><p>The password is mochi.</p></body></html>',
    }),
  ).toMatchObject({
    type: 'snapshot',
    page: { content: { kind: 'text', text: expect.stringContaining('The password is mochi.') } },
  })
})

test('the token listener answers the CORS preflight of the release webview and the dev URL, and of no other origin', async () => {
  const backend = await startBackend(freePort(), () => ({
    MONICA_DEV_URL: 'http://localhost:1420/',
  }))

  const allowed = async (origin: string) =>
    (
      await fetch(`http://127.0.0.1:${backend.port}/rpc/workbench/layout/get`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
    ).headers.get('access-control-allow-origin')

  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420'])
    expect([origin, await allowed(origin)]).toEqual([origin, origin])
  expect(await allowed('https://evil.example')).toBeNull()
})

test('the Backend answers /health without a token with the pid that backend.json names', async () => {
  const backend = await startBackend(freePort())

  const health = await fetch(`http://127.0.0.1:${backend.port}/health`)

  expect(health.status).toBe(200)
  const { name, pid } = (await health.json()) as { name: string; pid: number }
  expect({ name, pid }).toEqual({ name: 'monica-backend', pid: backend.subprocess.pid })
  expect(JSON.parse(readFileSync(join(backend.home, 'backend.json'), 'utf8')).pid).toBe(pid)
})

test('the Backend announces its endpoint only after monica-ptyd answers the List of its reconcile, and after 3 seconds when it never does', async () => {
  let release: (() => void) | undefined
  const held = spawnBackend(freePort(), () => ({}), {
    beforeSpawn: (ptyd) => {
      release = ptyd.holdNext('list')
    },
  })
  const announced = held.endpoint().then(() => 'announced')

  expect(await Promise.race([announced, Bun.sleep(1000).then(() => 'silent')])).toBe('silent')
  release?.()
  expect(await announced).toBe('announced')

  const startedAt = performance.now()
  const never = spawnBackend(freePort(), () => ({}), {
    beforeSpawn: (ptyd) => void ptyd.holdNext('list'),
  })
  await never.endpoint()
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(3000)
  const lines = await stderrAfterExit(never)
  expect(lines.filter((line) => line.includes('not ready after 3s'))).toHaveLength(1)
})

test('the Backend kills the claude that is still answering when it gets SIGTERM', async () => {
  const backend = await startBackend(freePort(), fakeClaude('answer'))
  const answer = await chatClient(backend).chat.ask({
    question: 'HOLD on, what is 1 + 1?',
    page: { content: { kind: 'unreadable', reason: 'restricted' } },
    history: [],
  })
  for (;;) {
    const { done, value } = await answer.next()
    if (!done && value.type === 'text') break
  }

  backend.subprocess.kill('SIGTERM')

  expect(
    await Promise.race([
      untilFakeClaudesExit(backend.home).then(() => 'gone'),
      Bun.sleep(2000).then(() => 'still answering'),
    ]),
  ).toBe('gone')
})

test('the Backend removes backend.json and exits 0 on SIGTERM and when its stdin closes', async () => {
  const terminated = await startBackend(freePort())
  const orphaned = await startBackend(freePort())

  terminated.subprocess.kill('SIGTERM')
  void orphaned.subprocess.stdin.end()

  for (const backend of [terminated, orphaned]) {
    expect(await backend.subprocess.exited).toBe(0)
    expect(existsSync(join(backend.home, 'backend.json'))).toBe(false)
  }
})

test('a token of an earlier Backend gets 401 with WWW-Authenticate on the token listener', async () => {
  const backend = await startBackend(freePort())

  const response = await viaToken(
    { port: backend.port, token: crypto.randomUUID() },
    'chat/ask',
    INVALID_QUESTION,
  )

  expect(response.status).toBe(401)
  expect(response.headers.get('www-authenticate')).toContain('invalid_token')
})

test('the endpoint line on stdout carries the port and the full token, and not the Chrome Extension token', async () => {
  const backend = await startBackend(freePort())

  expect(backend.announced).toEqual({ type: 'endpoint', port: backend.port, token: backend.token })
  expect(endpointFile(backend.home).token).toBe(backend.token)
})
