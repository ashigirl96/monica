import { afterEach, expect, spyOn, test } from 'bun:test'

import { FakeChrome } from './fake-chrome.ts'
import { readPage } from './read-page.ts'

let fake: FakeChrome
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  fake.uninstall()
})

async function until<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(1)
  }
}

/** PDF を読む上限の bytes。HTML のページでは使わない。 */
const LIMIT = 1024

function install() {
  fake = new FakeChrome(1, [
    { id: 10, windowId: 1, url: 'https://coast.example/tide-pools', title: 'Tide pools' },
  ])
  fake.install()
}

const tabOf = (id: number) => fake.tabs.find((tab) => tab.id === id) as chrome.tabs.Tab

test('the page is read by a script in the top frame of the Browser Tab only, injected without waiting for the page to load', async () => {
  install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: '' })

  await readPage(tabOf(10), LIMIT)

  expect(fake.injections).toEqual([
    { target: { tabId: 10 }, func: expect.any(Function), injectImmediately: true },
  ])
})

test('the HTML and the selection that the script returns go into the page with the URL and title of the Browser Tab', async () => {
  install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: 'the splash zone' })

  expect(await readPage(tabOf(10), LIMIT)).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    selection: 'the splash zone',
    content: { kind: 'html', html: '<body>Tide</body>' },
  })
})

test('an empty selection is left out', async () => {
  install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: '' })

  expect(await readPage(tabOf(10), LIMIT)).not.toHaveProperty('selection')
})

// chrome://・Web Store・ブラウザ拡張のページなどで executeScript は reject する。
test('a page the browser refuses to run the script in cannot be read, with the error as the detail', async () => {
  install()
  fake.readings.set(10, { error: 'Cannot access a chrome:// URL' })

  expect(await readPage(tabOf(10), LIMIT)).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    content: { kind: 'unreadable', reason: 'restricted', detail: 'Cannot access a chrome:// URL' },
  })
})

// view-source:、alert() の最中、frozen のタブで executeScript は返らない。
test('a page that does not answer the script within 3 seconds cannot be read', async () => {
  install()
  fake.readings.set(10, 'hang')
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout')

  const reading = readPage(tabOf(10), LIMIT)
  const limit = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 3000)
  setTimeoutSpy.mockRestore()
  limit?.[0]()

  expect(await reading).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    content: { kind: 'unreadable', reason: 'timeout' },
  })
})

const PDF_URL = 'https://coast.example/tides.pdf'
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nthe tide tables')

/** PDF viewer の Browser Tab。注入した関数は document.contentType だけを返す。 */
function installPdfTab() {
  fake = new FakeChrome(1, [{ id: 10, windowId: 1, url: PDF_URL, title: 'tides.pdf' }])
  fake.install()
  fake.readings.set(10, { contentType: 'application/pdf' })
}

// 偽の fetch。本物と同じく signal の abort で reject する。
function fakeFetch(respond: (signal: AbortSignal) => Response | Promise<never>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url, init })
    return respond(init!.signal!)
  }) as unknown as typeof fetch)
  cleanups.push(() => spy.mockRestore())
  return calls
}

/** chunk を 1 つずつ渡す body。読まれた chunk の数を数える。 */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
  return { response: new Response(body, { headers }), pulled: () => pulled }
}

test('a Browser Tab showing a PDF has its URL fetched with the cookies of the browser, and the bytes go as the PDF without a selection', async () => {
  installPdfTab()
  const calls = fakeFetch(() => new Response(PDF_BYTES))

  const page = await readPage(tabOf(10), LIMIT)

  expect(calls).toEqual([
    { url: PDF_URL, init: expect.objectContaining({ credentials: 'include' }) },
  ])
  expect(page).toEqual({
    url: PDF_URL,
    title: 'tides.pdf',
    content: { kind: 'pdf', pdf: expect.any(File) },
  })
  if (page.content.kind !== 'pdf') throw new Error('no PDF')
  expect(new Uint8Array(await page.content.pdf.arrayBuffer())).toEqual(PDF_BYTES)
})

test('a PDF whose response is not ok cannot be fetched, with the status as the detail', async () => {
  installPdfTab()
  fakeFetch(() => new Response('gone', { status: 404 }))

  expect((await readPage(tabOf(10), LIMIT)).content).toEqual({
    kind: 'unreadable',
    reason: 'fetch-failed',
    detail: 'HTTP 404',
  })
})

// ログインが要る PDF は、ログインのページの HTML が 200 で返りうる。
test('a response that does not start as a PDF cannot be fetched as one', async () => {
  installPdfTab()
  fakeFetch(() => new Response('<!doctype html><title>Sign in</title>'))

  expect((await readPage(tabOf(10), LIMIT)).content).toEqual({
    kind: 'unreadable',
    reason: 'fetch-failed',
    detail: 'the response is not a PDF',
  })
})

test('a PDF whose Content-Length passes the limit is too large, and its body is not read', async () => {
  installPdfTab()
  const body = streamed([PDF_BYTES], { 'content-length': String(LIMIT + 1) })
  fakeFetch(() => body.response)

  expect((await readPage(tabOf(10), LIMIT)).content).toEqual({
    kind: 'unreadable',
    reason: 'too-large',
  })
  expect(body.pulled()).toBeLessThanOrEqual(1)
})

test('a PDF that passes the limit while it is read is too large, and the rest is not read', async () => {
  installPdfTab()
  const chunk = new Uint8Array(LIMIT / 2)
  chunk.set(PDF_BYTES)
  const body = streamed([chunk, chunk, new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)])
  fakeFetch(() => body.response)

  expect((await readPage(tabOf(10), LIMIT)).content).toEqual({
    kind: 'unreadable',
    reason: 'too-large',
  })
  expect(body.pulled()).toBeLessThan(5)
})

test('a PDF exactly at the limit goes', async () => {
  installPdfTab()
  const bytes = new Uint8Array(LIMIT)
  bytes.set(PDF_BYTES)
  fakeFetch(() => streamed([bytes], { 'content-length': String(LIMIT) }).response)

  expect((await readPage(tabOf(10), LIMIT)).content).toMatchObject({ kind: 'pdf' })
})

test('a PDF that does not arrive within 30 seconds cannot be fetched', async () => {
  installPdfTab()
  fakeFetch(
    (signal) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      ),
  )
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
  cleanups.push(() => setTimeoutSpy.mockRestore())

  const reading = readPage(tabOf(10), LIMIT)
  const limit = await until(() => setTimeoutSpy.mock.calls.find(([, ms]) => ms === 30_000))
  limit[0]()

  expect((await reading).content).toEqual({
    kind: 'unreadable',
    reason: 'fetch-failed',
    detail: 'no response within 30 seconds',
  })
})
