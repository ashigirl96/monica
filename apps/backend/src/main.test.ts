import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'

import { startFakePtyd, tempHome } from '@monica/workbench/testing'

import { freePort } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

type Announcement =
  | { type: 'endpoint'; port: number; token: string }
  | { type: 'notify'; title: string; body: string; terminalSessionId: string }
  | { type: 'badge'; count: number }

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

// main.ts は Backend の組み立てそのものなので、Shell と同じく process として起こす。
async function startBackend(notesPort: number) {
  const home = tempHome((cleanup) => cleanups.push(cleanup))
  const ptyd = startFakePtyd(home)
  cleanups.push(() => ptyd.stop())
  const { MONICA_NOTES_PORT: _, ...env } = process.env
  const backend = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: {
      ...env,
      MONICA_HOME: home,
      MONICA_PTYD_PATH: join(home, 'no-ptyd'),
      MONICA_NOTES_PORT: String(notesPort),
      // login shell の rc を読む時間を短くする。
      SHELL: '/bin/sh',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  cleanups.push(() => backend.kill())
  const next = announcements(backend.stdout)
  const beforeEndpoint: Announcement[] = []
  for (;;) {
    const line = await next()
    if (line.type === 'endpoint')
      return { port: line.port, token: line.token, beforeEndpoint, next }
    beforeEndpoint.push(line)
  }
}

function viaToken(
  { port, token }: { port: number; token: string },
  path: string,
  input: object = {},
) {
  return fetch(`http://127.0.0.1:${port}/rpc/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  })
}

test('the token listener carries workbench, task and job but not note, and the notes listener only note', async () => {
  const notesPort = freePort()
  const backend = await startBackend(notesPort)

  const viaNotes = (path: string) =>
    fetch(`http://127.0.0.1:${notesPort}/rpc/${path}`, {
      method: 'POST',
      headers: {
        host: `monica.localhost:${notesPort}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ json: {} }),
    })

  for (const path of ['workbench/layout/get', 'task/list', 'job/list']) {
    expect([path, (await viaToken(backend, path)).status]).toEqual([path, 200])
    expect([path, (await viaNotes(path)).status]).toEqual([path, 404])
  }
  expect((await viaNotes('note/essay/create')).status).toBe(200)
  expect((await viaToken(backend, 'note/essay/create')).status).toBe(404)
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

test('the Backend tells the Shell the unread count before its endpoint and again when a notified wait adds one', async () => {
  const backend = await startBackend(freePort())

  await waitInANewTab(backend)

  expect(backend.beforeEndpoint).toEqual([{ type: 'badge', count: 0 }])
  expect(await nextOf(backend, 'badge')).toEqual({ type: 'badge', count: 1 })
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
