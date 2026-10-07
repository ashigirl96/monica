import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'

import { startFakePtyd, tempHome } from '@tania/workbench/testing'

import { freePort } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

async function endpointLine(stdout: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stdout) {
    text += decoder.decode(chunk, { stream: true })
    const line = text
      .split('\n')
      .slice(0, -1)
      .find((complete) => complete.includes('"endpoint"'))
    if (line) return JSON.parse(line) as { port: number; token: string }
  }
  throw new Error('the Backend exited without announcing its endpoint')
}

// main.ts は Backend の組み立てそのものなので、Shell と同じく process として起こす。
async function startBackend(notesPort: number) {
  const home = tempHome((cleanup) => cleanups.push(cleanup))
  const ptyd = startFakePtyd(home)
  cleanups.push(() => ptyd.stop())
  const { TANIA_NOTES_PORT: _, ...env } = process.env
  const backend = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: {
      ...env,
      TANIA_HOME: home,
      TANIA_PTYD_PATH: join(home, 'no-ptyd'),
      TANIA_NOTES_PORT: String(notesPort),
      // login shell の rc を読む時間を短くする。
      SHELL: '/bin/sh',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  cleanups.push(() => backend.kill())
  return endpointLine(backend.stdout)
}

function viaToken({ port, token }: { port: number; token: string }, path: string) {
  return fetch(`http://127.0.0.1:${port}/rpc/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: {} }),
  })
}

test('the token listener carries workbench, task and job but not note, and the notes listener only note', async () => {
  const notesPort = freePort()
  const backend = await startBackend(notesPort)

  const viaNotes = (path: string) =>
    fetch(`http://127.0.0.1:${notesPort}/rpc/${path}`, {
      method: 'POST',
      headers: {
        host: `tania.localhost:${notesPort}`,
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

test('the Backend hands the Job Ledger the system Jobs of task and note', async () => {
  const response = await viaToken(await startBackend(freePort()), 'job/list')
  const { json } = (await response.json()) as { json: { jobs: { name: string }[] } }

  expect(json.jobs.map(({ name }) => name)).toEqual([
    'task.sync',
    'task.setup-log-cleanup',
    'note.image-cleanup',
  ])
}, 20_000)
