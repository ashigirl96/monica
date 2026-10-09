import { afterEach, expect, spyOn, test } from 'bun:test'

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { implement } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

import { contract } from '../contract.ts'
import { type ChatStore, createChatStore } from './chat-store.ts'
import { FakeChrome } from './fake-chrome.ts'
import { viaNativeHost } from './native-host.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

const HOST = 'com.ashigirl96.monica_dev'

/** token の口の chat。違う token には hono の bearerAuth と同じく 401 を返す。届いた Authorization を残す。 */
function fakeBackend(extensionToken: string) {
  const os = implement(contract)
  const handler = new RPCHandler({
    chat: os.router({
      prepare: os.prepare.handler(() => {}),
      ask: os.ask.handler(async function* () {}),
    }),
  })
  const authorizations: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get('authorization') ?? ''
      authorizations.push(authorization)
      if (authorization !== `Bearer ${extensionToken}`)
        return new Response('Unauthorized', { status: 401 })
      const { response } = await handler.handle(request, { prefix: '/rpc', context: {} })
      return response ?? new Response('Not Found', { status: 404 })
    },
  })
  cleanups.push(() => void server.stop(true))
  return { port: server.port!, authorizations }
}

function sidePanel() {
  const chrome = new FakeChrome(1, [])
  chrome.install()
  cleanups.push(() => chrome.uninstall())
  const client: ContractRouterClient<{ chat: typeof contract }> = createORPCClient(
    new RPCLink(viaNativeHost(HOST)),
  )
  return { chrome, client }
}

function openChat(client: ContractRouterClient<{ chat: typeof contract }>) {
  const store = createChatStore(client.chat)
  const stop = store.open(
    () => ({ shown: {}, page: new Promise<never>(() => {}) }),
    new EventTarget(),
  )
  cleanups.push(stop)
  return store
}

async function untilBanner(store: ChatStore, shown: boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (store.snapshot().unreachable === shown) return
    await Bun.sleep(5)
  }
  throw new Error(`the banner is still ${shown ? 'down' : 'up'}`)
}

// Backend は起き直すたびに port と Chrome Extension の token を変えるので、side panel は覚えておかない。
test('each call asks the native host for the Backend again and goes to the port it names with the Chrome Extension token it names', async () => {
  const { chrome, client } = sidePanel()
  const before = fakeBackend('chat-1')
  const after = fakeBackend('chat-2')

  chrome.nativeHost = { reply: { port: before.port, token: 'chat-1' } }
  await client.chat.prepare()
  chrome.nativeHost = { reply: { port: after.port, token: 'chat-2' } }
  await client.chat.prepare()

  expect(chrome.nativeMessages).toEqual([
    { host: HOST, message: {} },
    { host: HOST, message: {} },
  ])
  expect(before.authorizations).toEqual(['Bearer chat-1'])
  expect(after.authorizations).toEqual(['Bearer chat-2'])
})

test.each([
  ['no native host is installed', () => undefined],
  ['the native host fails', () => ({ error: 'Native host has exited.' })],
  ['the native host finds no live Backend', () => ({ reply: { error: 'not-running' } })],
  [
    'the Backend no longer takes the Chrome Extension token',
    () => ({ reply: { port: fakeBackend('restarted').port, token: 'stale' } }),
  ],
])('a side panel opened when %s puts up the banner', async (_, reply) => {
  const { chrome, client } = sidePanel()
  chrome.nativeHost = reply()

  const store = openChat(client)

  await untilBanner(store, true)
})

test('a banner put up for a stale Chrome Extension token comes down at the next check once the native host names the restarted Backend', async () => {
  const timers = spyOn(globalThis, 'setInterval')
  cleanups.push(() => timers.mockRestore())
  const { chrome, client } = sidePanel()
  const backend = fakeBackend('restarted')
  chrome.nativeHost = { reply: { port: backend.port, token: 'stale' } }
  const store = openChat(client)
  await untilBanner(store, true)

  chrome.nativeHost = { reply: { port: backend.port, token: 'restarted' } }
  const check = timers.mock.calls.at(-1)![0] as () => void
  check()

  await untilBanner(store, false)
  expect(backend.authorizations).toEqual(['Bearer stale', 'Bearer restarted'])
})
