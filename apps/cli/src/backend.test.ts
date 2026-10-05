import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RPCHandler } from '@orpc/server/fetch'

import { connect } from './backend.ts'
import { inMemoryBackend, tania } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function taniaHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tania-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function writeEndpoint(home: string, endpoint: { port: number; pid: number }) {
  writeFileSync(join(home, 'backend.json'), JSON.stringify({ ...endpoint, token: 'token' }))
}

function serveBackend(home: string) {
  const backend = inMemoryBackend()
  const handler = new RPCHandler(backend.router)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { response } = await handler.handle(request, {
        prefix: '/rpc',
        context: backend.context,
      })
      return response ?? new Response('not found', { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true))
  writeEndpoint(home, { port: server.port!, pid: process.pid })
  return backend
}

function refusedPort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = server.port!
  server.stop(true)
  return port
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

const list = ['workbench', 'terminal-session', 'list']

test('a procedure that fails in the Backend prints one CODE: message line on stderr and exits 1', async () => {
  const home = taniaHome()
  serveBackend(home).sqlite.close()

  const result = await tania(list, () => connect(home))

  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^INTERNAL_SERVER_ERROR: [^\n]+\n$/)
})

test('while the Backend refuses connections the CLI rereads backend.json and reaches the restarted one', async () => {
  const home = taniaHome()
  writeEndpoint(home, { port: refusedPort(), pid: process.pid })
  setTimeout(() => serveBackend(home), 300)

  const result = await tania(list, () => connect(home))

  expect(result.code).toBe(0)
  expect(result.stdout).toContain('ts-a')
})

test('no backend.json, or one whose pid is dead, means no Backend', async () => {
  const missing = taniaHome()
  const stale = taniaHome()
  writeEndpoint(stale, { port: refusedPort(), pid: await deadPid() })

  expect(connect(missing)).toBeNull()
  expect(connect(stale)).toBeNull()
})
