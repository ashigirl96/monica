import { afterEach, expect, spyOn, test } from 'bun:test'

import { FakeChrome } from './fake-chrome.ts'
import { readPage } from './read-page.ts'

let fake: FakeChrome

afterEach(() => fake.uninstall())

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

  await readPage(tabOf(10))

  expect(fake.injections).toEqual([
    { target: { tabId: 10 }, func: expect.any(Function), injectImmediately: true },
  ])
})

test('the HTML and the selection that the script returns go into the page with the URL and title of the Browser Tab', async () => {
  install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: 'the splash zone' })

  expect(await readPage(tabOf(10))).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    selection: 'the splash zone',
    content: { kind: 'html', html: '<body>Tide</body>' },
  })
})

test('an empty selection is left out', async () => {
  install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: '' })

  expect(await readPage(tabOf(10))).not.toHaveProperty('selection')
})

// chrome://・Web Store・ブラウザ拡張のページなどで executeScript は reject する。
test('a page the browser refuses to run the script in cannot be read, with the error as the detail', async () => {
  install()
  fake.readings.set(10, { error: 'Cannot access a chrome:// URL' })

  expect(await readPage(tabOf(10))).toEqual({
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

  const reading = readPage(tabOf(10))
  const limit = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 3000)
  setTimeoutSpy.mockRestore()
  limit?.[0]()

  expect(await reading).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    content: { kind: 'unreadable', reason: 'timeout' },
  })
})
