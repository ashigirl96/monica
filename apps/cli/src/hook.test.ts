import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

import { cleanUp, inMemoryBackend, openTabOutsideBench } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  cleanUp()
})

function monicaHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'monica-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function writeEndpoint(home: string, port: number) {
  writeFileSync(
    join(home, 'backend.json'),
    JSON.stringify({ port, pid: process.pid, token: 'token' }),
  )
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
  writeEndpoint(home, server.port!)
  return { ...backend, client: createRouterClient(backend.router, { context: backend.context }) }
}

const exitPlanMode = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../docs/research/hook-payloads/permission-request-exit-plan-mode.json',
    ),
    'utf8',
  ),
)

const prompt = {
  session_id: 's-1',
  cwd: '/work',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'hi',
}

async function hook(home: string, payload: object, env: Record<string, string> = {}) {
  const startedAt = performance.now()
  const child = Bun.spawn(
    ['bun', join(import.meta.dir, 'main.ts'), 'workbench', 'hook', 'claude'],
    {
      env: { PATH: process.env.PATH!, MONICA_HOME: home, ...env },
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = await new Response(child.stdout).text()
  const code = await child.exited
  return { code, stdout, elapsedMs: performance.now() - startedAt }
}

const inTab = { MONICA_TERMINAL_SESSION_ID: 'ts-a' }

test("a hook from a Tab is recorded by the Backend under the Tab's Terminal Session", async () => {
  const home = monicaHome()
  const { client } = serveBackend(home)
  const terminalSessionId = await openTabOutsideBench(client)

  const result = await hook(home, prompt, { MONICA_TERMINAL_SESSION_ID: terminalSessionId })

  expect(result).toMatchObject({ code: 0, stdout: '' })
  expect(await client.workbench.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', terminalSessionId, state: 'running' }),
  ])
})

test('a hook outside any Tab is not sent to the Backend', async () => {
  const home = monicaHome()
  const { client } = serveBackend(home)

  const result = await hook(home, prompt)

  expect(result).toMatchObject({ code: 0, stdout: '' })
  expect(await client.workbench.agentSession.list()).toEqual([])
})

test('ExitPlanMode is allowed into auto mode with its input handed back, without waiting for a Backend', async () => {
  const home = monicaHome()

  const result = await hook(home, exitPlanMode, inTab)

  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: exitPlanMode.tool_input,
        updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
      },
    },
  })
})

test('without a Backend, or with one that fails or refuses, the hook exits 0 at once', async () => {
  const absent = monicaHome()
  const failing = monicaHome()
  serveBackend(failing).sqlite.close()
  const refusing = monicaHome()
  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  writeEndpoint(refusing, closed.port!)
  void closed.stop(true)

  for (const home of [absent, failing, refusing]) {
    const result = await hook(home, prompt, inTab)

    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.elapsedMs).toBeLessThan(1500)
  }
})

test('a Backend that does not answer is given up after 2 seconds and the hook exits 0', async () => {
  const home = monicaHome()
  const hung = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  cleanups.push(() => hung.stop(true))
  writeEndpoint(home, hung.port!)

  const result = await hook(home, prompt, inTab)

  expect(result).toMatchObject({ code: 0, stdout: '' })
  expect(result.elapsedMs).toBeGreaterThan(1900)
  expect(result.elapsedMs).toBeLessThan(3000)
})
