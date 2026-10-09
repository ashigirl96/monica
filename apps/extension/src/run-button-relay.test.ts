import { afterEach, expect, test } from 'bun:test'

import { contract } from '@monica/task/contract'
import { implement, ORPCError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

import { relayRunButton } from './run-button-relay.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

const HOST = 'com.ashigirl96.monica_dev'
const TOKEN = 'extension-token'

/** token の口の task の 3 つ。違う token には hono の bearerAuth と同じく 401 を返す。届いた呼び出しを残す。 */
function fakeBackend() {
  const calls: { path: string; input: unknown }[] = []
  const os = implement({
    runButtons: contract.runButtons,
    runFromButton: contract.runFromButton,
    reopenFromButton: contract.reopenFromButton,
  })
  const handler = new RPCHandler({
    task: os.router({
      runButtons: os.runButtons.handler(({ input }) => {
        calls.push({ path: 'runButtons', input })
        return {
          buttons: input.refs.map((ref) => ({
            ref,
            ...(ref.endsWith('#12')
              ? { button: { kind: 'tackle' as const, run: 'new' as const }, reason: null }
              : { button: null, reason: `${ref} has no label that picks a prompt` }),
          })),
        }
      }),
      runFromButton: os.runFromButton.handler(({ input }) => {
        calls.push({ path: 'runFromButton', input })
        if (input.ref.endsWith('#13')) {
          throw new ORPCError('PRECONDITION_FAILED', {
            message: `${input.ref} has no label that picks a prompt`,
          })
        }
        if (input.ref.endsWith('#14')) throw new ORPCError('CONFLICT', { message: 'a live Run' })
        return {
          ref: input.ref,
          title: 'Ship it',
          tracked: true,
          cwd: '/tmp/issue-12',
          mode: 'worktree' as const,
          benchCreated: true,
          warnings: [],
          tabId: 't-1',
          terminalSessionId: 'ts-1',
          resumed: null,
        }
      }),
      reopenFromButton: os.reopenFromButton.handler(({ input }) => {
        calls.push({ path: 'reopenFromButton', input })
        if (input.ref.endsWith('#13')) {
          throw new ORPCError('BAD_REQUEST', { message: `${input.ref} is not a closed Task` })
        }
        return { ref: input.ref, title: 'Ship it', warnings: [] }
      }),
    }),
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`)
        return new Response('Unauthorized', { status: 401 })
      const { response } = await handler.handle(request, { prefix: '/rpc', context: {} })
      return response ?? new Response('Not Found', { status: 404 })
    },
  })
  cleanups.push(() => void server.stop(true))
  return { port: server.port!, calls }
}

/** service worker が触る chrome.runtime.sendNativeMessage だけを置く。reply が undefined なら host が無い。 */
function nativeHost(reply: unknown) {
  const asked: string[] = []
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        async sendNativeMessage(host: string) {
          asked.push(host)
          if (reply === undefined) throw new Error('Specified native messaging host not found.')
          return reply
        },
      },
    },
  })
  cleanups.push(() => Reflect.deleteProperty(globalThis, 'chrome'))
  return asked
}

test('the relay asks the native host and tells the buttons the Backend gives for the refs', async () => {
  const backend = fakeBackend()
  const asked = nativeHost({ port: backend.port, token: TOKEN })

  const reply = await relayRunButton(HOST, {
    type: 'monica.runButtons',
    refs: ['acme/app#12', 'acme/app#13'],
  })

  expect(reply).toEqual({
    buttons: [
      { ref: 'acme/app#12', button: { kind: 'tackle', run: 'new' }, reason: null },
      {
        ref: 'acme/app#13',
        button: null,
        reason: 'acme/app#13 has no label that picks a prompt',
      },
    ],
  })
  expect(asked).toEqual([HOST])
  expect(backend.calls).toEqual([
    { path: 'runButtons', input: { refs: ['acme/app#12', 'acme/app#13'] } },
  ])
})

test('the relay runs the ref alone and tells whether the Backend ran it or why it refused', async () => {
  const backend = fakeBackend()
  nativeHost({ port: backend.port, token: TOKEN })

  expect(await relayRunButton(HOST, { type: 'monica.runFromButton', ref: 'acme/app#12' })).toEqual({
    accepted: true,
  })
  expect(await relayRunButton(HOST, { type: 'monica.runFromButton', ref: 'acme/app#13' })).toEqual({
    accepted: false,
    reason: 'acme/app#13 has no label that picks a prompt',
  })
  expect(await relayRunButton(HOST, { type: 'monica.runFromButton', ref: 'acme/app#14' })).toEqual({
    accepted: false,
    reason: 'a live Run',
  })
  expect(backend.calls.map(({ input }) => input)).toEqual([
    { ref: 'acme/app#12' },
    { ref: 'acme/app#13' },
    { ref: 'acme/app#14' },
  ])
})

test('the relay reopens the ref alone and tells whether the Backend reopened it or why it refused', async () => {
  const backend = fakeBackend()
  nativeHost({ port: backend.port, token: TOKEN })

  expect(
    await relayRunButton(HOST, { type: 'monica.reopenFromButton', ref: 'acme/app#12' }),
  ).toEqual({ accepted: true })
  expect(
    await relayRunButton(HOST, { type: 'monica.reopenFromButton', ref: 'acme/app#13' }),
  ).toEqual({ accepted: false, reason: 'acme/app#13 is not a closed Task' })
  expect(backend.calls).toEqual([
    { path: 'reopenFromButton', input: { ref: 'acme/app#12' } },
    { path: 'reopenFromButton', input: { ref: 'acme/app#13' } },
  ])
})

test.each([
  ['there is no native host', () => undefined],
  ['the Backend is not running', () => ({ error: 'not-running' })],
  ['the Backend no longer takes the token', (port: number) => ({ port, token: 'stale' })],
  ['nothing listens on the port', () => ({ port: 1, token: TOKEN })],
])('the relay tells the Backend is out of reach when %s', async (_, reply) => {
  const backend = fakeBackend()
  nativeHost(reply(backend.port))

  expect(
    await relayRunButton(HOST, { type: 'monica.runButtons', refs: ['acme/app#12'] }),
  ).toBeNull()
})

test('the relay leaves a message that is not for it to other listeners', async () => {
  expect(relayRunButton(HOST, { type: 'something else' })).toBeUndefined()
  expect(relayRunButton(HOST, 'acme/app#12')).toBeUndefined()
})
