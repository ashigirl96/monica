import { afterEach, expect, test } from 'bun:test'

import { createRouterClient } from '@orpc/server'

import type { Client } from './backend.ts'
import { cleanUp, inMemoryBackend, openTabOutsideBench, tania } from './testing.ts'

afterEach(cleanUp)

function inProcessClient(): Client {
  const { router, context } = inMemoryBackend()
  return createRouterClient(router, { context })
}

test('terminal-session list prints the live sessions as text', async () => {
  const client = inProcessClient()
  const id = await openTabOutsideBench(client)

  const result = await tania(['workbench', 'terminal-session', 'list'], () => client)

  expect(result).toEqual({
    code: 0,
    stdout: `${'ID'.padEnd(id.length)}  STATUS   PID   CWD\n${id}  running  1000  /work\n`,
    stderr: '',
  })
})

test('agent-session list prints each live Agent Session with its state and reason as text', async () => {
  const client = inProcessClient()
  const id = await openTabOutsideBench(client)
  await client.workbench.agentSession.recordHook({
    terminalSessionId: id,
    payload: {
      session_id: '6253bdb0-26c3-4dd3-bc04-34af7ebcc00e',
      cwd: '/work/repo',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
    },
  })

  const result = await tania(['workbench', 'agent-session', 'list'], () => client)

  expect(result).toEqual({
    code: 0,
    stdout:
      `ID        ${'TERMINAL SESSION'.padEnd(id.length)}  STATE                       CWD\n` +
      `6253bdb0  ${id}  waiting (permission: Bash)  /work/repo\n`,
    stderr: '',
  })
})

test('--format json prints the procedure output as it is', async () => {
  const client = inProcessClient()
  const id = await openTabOutsideBench(client)

  const result = await tania(
    ['workbench', 'terminal-session', 'list', '--format', 'json'],
    () => client,
  )

  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    {
      id,
      cwd: '/work',
      shell: expect.any(String),
      status: 'running',
      pid: 1000,
      exitCode: null,
      error: null,
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      endedAt: null,
      tabId: expect.any(String),
    },
  ])
})

test('without a Backend the CLI exits 2', async () => {
  const result = await tania(['workbench', 'terminal-session', 'list'], () => null)

  expect(result.code).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^BACKEND_NOT_RUNNING: [^\n]+\n$/)
})

test('a usage error prints one CODE: message line on stderr and exits 1', async () => {
  const client = inProcessClient()

  const unknownFlag = await tania(
    ['workbench', 'terminal-session', 'list', '--no-such-flag'],
    () => client,
  )
  const badFormat = await tania(
    ['workbench', 'terminal-session', 'list', '--format', 'xml'],
    () => client,
  )
  const unknownCommand = await tania(['workbench', 'nope'], () => client)

  expect(unknownFlag).toEqual({
    code: 1,
    stdout: '',
    stderr: "BAD_REQUEST: unknown option '--no-such-flag'\n",
  })
  expect(badFormat.code).toBe(1)
  expect(badFormat.stderr).toMatch(
    /^BAD_REQUEST: option '--format <format>' argument 'xml' is invalid\.[^\n]*\n$/,
  )
  expect(unknownCommand).toEqual({
    code: 1,
    stdout: '',
    stderr: "BAD_REQUEST: unknown command 'nope'\n",
  })
})
