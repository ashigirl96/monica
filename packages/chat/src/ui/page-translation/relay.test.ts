import { afterEach, expect, test } from 'bun:test'

import { implement } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'

import { contract } from '../../contract.ts'
import { FakeChrome } from '../fake-chrome.ts'
import {
  forgetPageTranslation,
  relayPageTranslation,
  reinjectPageTranslation,
  showPageTranslationState,
} from './relay.ts'

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
  const stored = new Map<string, unknown>()
  Object.assign((globalThis as unknown as { chrome: object }).chrome, {
    storage: {
      session: {
        get: async (key: string) => (stored.has(key) ? { [key]: stored.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) stored.set(key, value)
        },
        remove: async (key: string) => void stored.delete(key),
      },
    },
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

const switched = (tabId: number, on: boolean) =>
  relayPageTranslation(HOST, { type: 'monica.pageTranslationSwitched', on }, sender(tabId))

const wanted = (tabId: number) =>
  relayPageTranslation(HOST, { type: 'monica.pageTranslationWanted' }, sender(tabId))

const loaded = (tabId: number, frameType: chrome.extensionTypes.FrameType = 'outermost_frame') =>
  ({
    tabId,
    frameType,
    documentId: `document-of-${tabId}`,
  }) as chrome.webNavigation.WebNavigationFramedCallbackDetails

test('a Browser Tab switched on with ⌥A gets the script again in the next document, and one switched off does not', async () => {
  const { chrome } = serviceWorker()
  await switched(7, true)
  await switched(8, true)
  await switched(8, false)

  for (const tabId of [7, 8, 9]) await reinjectPageTranslation(loaded(tabId), 'resume.js')

  expect(chrome.injections).toEqual([
    { target: { tabId: 7, documentIds: ['document-of-7'] }, files: ['resume.js'] },
  ])
})

test('a document restored by back or forward asks whether ⌥A left Page Translation on in its Browser Tab', async () => {
  serviceWorker()
  await switched(7, true)
  await switched(8, true)
  await switched(8, false)

  expect(await Promise.all([wanted(7), wanted(8), wanted(9)])).toEqual([true, false, false])
})

test('the state a document reports goes only to the badge, so a document restored by back or forward does not switch its Browser Tab on', async () => {
  serviceWorker()
  await switched(7, false)

  await relayPageTranslation(
    HOST,
    { type: 'monica.pageTranslationState', state: { kind: 'translated' } },
    sender(7),
  )

  expect(await wanted(7)).toBe(false)
})

test('a frame inside the page does not get the script', async () => {
  const { chrome } = serviceWorker()
  await switched(7, true)

  await reinjectPageTranslation(loaded(7, 'sub_frame'), 'resume.js')

  expect(chrome.injections).toEqual([])
})

test('a page that refuses the script, such as chrome://, shows no failure on the badge', async () => {
  const { chrome, badges } = serviceWorker()
  await switched(7, true)

  await reinjectPageTranslation(loaded(7), 'resume.js')

  expect(chrome.injections).toHaveLength(1)
  expect(badges).toEqual([])
})

test('a closed Browser Tab is forgotten', async () => {
  serviceWorker()
  await switched(7, true)

  await forgetPageTranslation(7)

  expect(await wanted(7)).toBe(false)
})
