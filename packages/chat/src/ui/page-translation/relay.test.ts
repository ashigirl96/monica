import { afterEach, expect, test } from 'bun:test'

import { implement } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

import { contract } from '../../contract.ts'
import { FakeChrome } from '../fake-chrome.ts'
import { relayPageTranslation, showPageTranslationState } from './relay.ts'

const HOST = 'com.ashigirl96.monica_dev'
const TOKEN = 'extension-token'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

type Answer = (segments: { id: number; text: string }[]) => { id: number; text: string }[]

function fakeBackend(answer: Answer | 'CHAT_BUSY' | 'AGENT_FAILED') {
  const os = implement(contract)
  const handler = new RPCHandler({
    chat: os.router({
      prepare: os.prepare.handler(() => {}),
      models: os.models.handler(() => []),
      ask: os.ask.handler(async function* () {}),
      translateSegments: os.translateSegments.handler(({ input, errors }) => {
        if (answer === 'CHAT_BUSY') throw errors.CHAT_BUSY()
        if (answer === 'AGENT_FAILED') {
          throw errors.AGENT_FAILED({ data: { detail: 'claude: out of memory' } })
        }
        return { segments: answer(input.segments) }
      }),
    }),
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { response } = await handler.handle(request, { prefix: '/rpc', context: {} })
      return response ?? new Response('Not Found', { status: 404 })
    },
  })
  cleanups.push(() => void server.stop(true))
  return server.port!
}

function serviceWorker() {
  const chrome = new FakeChrome(1, [])
  chrome.install()
  const badges: { tabId: number; text: string }[] = []
  const titles: { tabId: number; title: string }[] = []
  Object.assign((globalThis as unknown as { chrome: object }).chrome, {
    action: {
      setBadgeText: async (details: { tabId: number; text: string }) => void badges.push(details),
      setTitle: async (details: { tabId: number; title: string }) => void titles.push(details),
    },
  })
  cleanups.push(() => chrome.uninstall())
  return { chrome, badges, titles }
}

const SEGMENTS = [{ id: 0, text: 'Tide pools' }]
const sender = (tabId: number) => ({ tab: { id: tabId } }) as chrome.runtime.MessageSender

test('segments from a Browser Tab go to the Backend the native host names, and its translation comes back', async () => {
  const { chrome } = serviceWorker()
  chrome.nativeHost = {
    reply: {
      port: fakeBackend((segments) => segments.map(({ id }) => ({ id, text: '潮だまり' }))),
      token: TOKEN,
    },
  }

  const reply = await relayPageTranslation(
    HOST,
    { type: 'monica.translateSegments', segments: SEGMENTS },
    sender(7),
  )

  expect(reply).toEqual({ segments: [{ id: 0, text: '潮だまり' }] })
})

test('a Backend that lends no claude to the translation answers busy, so that the Browser Tab sends again later', async () => {
  const { chrome } = serviceWorker()
  chrome.nativeHost = { reply: { port: fakeBackend('CHAT_BUSY'), token: TOKEN } }

  expect(
    await relayPageTranslation(
      HOST,
      { type: 'monica.translateSegments', segments: SEGMENTS },
      sender(7),
    ),
  ).toEqual({ busy: true })
})

test('a desktop that is not running and a claude that fails answer the reason', async () => {
  serviceWorker()

  expect(
    await relayPageTranslation(
      HOST,
      { type: 'monica.translateSegments', segments: SEGMENTS },
      sender(7),
    ),
  ).toEqual({ failed: 'the monica desktop is not running' })

  const { chrome } = serviceWorker()
  chrome.nativeHost = { reply: { port: fakeBackend('AGENT_FAILED'), token: TOKEN } }
  expect(
    await relayPageTranslation(
      HOST,
      { type: 'monica.translateSegments', segments: SEGMENTS },
      sender(7),
    ),
  ).toEqual({ failed: 'claude could not answer: claude: out of memory' })
})

test('the state of a Browser Tab goes to the badge of that tab, with the reason of a failure in the tooltip', async () => {
  const { badges, titles } = serviceWorker()

  await relayPageTranslation(
    HOST,
    { type: 'monica.pageTranslationState', state: { kind: 'translating' } },
    sender(7),
  )
  showPageTranslationState(7, { kind: 'failed', reason: 'the monica desktop is not running' })
  showPageTranslationState(7, { kind: 'original' })

  expect(badges).toEqual([
    { tabId: 7, text: '…' },
    { tabId: 7, text: '!' },
    { tabId: 7, text: '' },
  ])
  expect(titles[1]).toEqual({
    tabId: 7,
    title: 'Page Translation failed: the monica desktop is not running',
  })
  expect(titles[2]).toEqual({ tabId: 7, title: '' })
})

test('a message for someone else is left to the other listeners', () => {
  serviceWorker()

  expect(
    relayPageTranslation(HOST, { type: 'monica.runButtons', refs: [] }, sender(7)),
  ).toBeUndefined()
})
