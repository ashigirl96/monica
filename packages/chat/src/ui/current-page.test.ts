import { afterEach, expect, test } from 'bun:test'

import { type CurrentPage, watchCurrentPage } from './current-page.ts'
import { FakeChrome } from './fake-chrome.ts'

let fake: FakeChrome

afterEach(() => fake.uninstall())

function open(...tabs: ConstructorParameters<typeof FakeChrome>[1]) {
  fake = new FakeChrome(1, tabs)
  fake.install()
  const pages: CurrentPage[] = []
  const watch = watchCurrentPage((page) => pages.push(page))
  return { pages, watch }
}

const settled = () => Bun.sleep(0)

test('opening reports the page of the active Browser Tab in the side panel window', async () => {
  const { pages } = open(
    { id: 20, windowId: 2, url: 'https://other.example/', title: 'Other window' },
    { id: 10, windowId: 1, url: 'https://ja.wikipedia.org/wiki/A', title: 'A - Wikipedia' },
    { id: 11, windowId: 1, url: 'https://example.com/', title: 'Example' },
  )
  await settled()

  expect(pages).toEqual([{ url: 'https://ja.wikipedia.org/wiki/A', title: 'A - Wikipedia' }])
})

test('activating another Browser Tab in the side panel window replaces the page', async () => {
  const { pages } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 11, windowId: 1, url: 'https://b.example/', title: 'B' },
  )
  await settled()

  fake.activate(11)
  await settled()

  expect(pages.at(-1)).toEqual({ url: 'https://b.example/', title: 'B' })
})

test('a new URL or title of the Browser Tab, from a navigation, pushState or a hash change, replaces the page', async () => {
  const { pages } = open({ id: 10, windowId: 1, url: 'https://a.example/', title: 'A' })
  await settled()

  fake.update(10, { url: 'https://b.example/' })
  fake.update(10, { title: 'B' })
  fake.update(10, { url: 'https://b.example/list' })
  fake.update(10, { url: 'https://b.example/list#item-3' })

  expect(pages.slice(1)).toEqual([
    { url: 'https://b.example/', title: 'A' },
    { url: 'https://b.example/', title: 'B' },
    { url: 'https://b.example/list', title: 'B' },
    { url: 'https://b.example/list#item-3', title: 'B' },
  ])
})

test('a change to a Browser Tab other than the Current Page leaves the page as it is', async () => {
  const { pages } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 11, windowId: 1, url: 'https://b.example/', title: 'B' },
    { id: 20, windowId: 2, url: 'https://x.example/', title: 'X' },
  )
  await settled()

  fake.update(11, { url: 'https://b.example/next', title: 'B next' })
  fake.update(20, { url: 'https://x.example/next', title: 'X next' })

  expect(pages).toEqual([{ url: 'https://a.example/', title: 'A' }])
})

test('a Browser Tab whose URL and title the side panel cannot see gives a page without them', async () => {
  const { pages } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 11, windowId: 1 },
  )
  await settled()

  fake.activate(11)
  await settled()

  expect(pages.at(-1)).toStrictEqual({})
})

test('moving the Browser Tab to a page the side panel cannot see gives a page without URL and title', async () => {
  const { pages } = open({ id: 10, windowId: 1, url: 'https://a.example/', title: 'A' })
  await settled()

  fake.leaveForUnreadable(10)

  expect(pages.at(-1)).toStrictEqual({})
})

test('stopping removes the listeners and drops a page still being read', async () => {
  const { pages, watch } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 11, windowId: 1, url: 'https://b.example/', title: 'B' },
  )
  await settled()

  fake.activate(11)
  watch.stop()
  await settled()

  expect(pages).toEqual([{ url: 'https://a.example/', title: 'A' }])
  expect([fake.activated.size, fake.updated.size]).toEqual([0, 0])
})

test('read asks again for the active Browser Tab of the side panel window, even when an event was missed', async () => {
  const { watch } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 11, windowId: 1, url: 'https://b.example/', title: 'B' },
    { id: 20, windowId: 2, url: 'https://x.example/', title: 'X' },
  )
  await settled()
  fake.activated.clear()

  fake.activate(11)

  expect(await watch.read()).toMatchObject({ id: 11, url: 'https://b.example/', title: 'B' })
})

test('activating a Browser Tab in another window leaves the page as it is', async () => {
  const { pages } = open(
    { id: 10, windowId: 1, url: 'https://a.example/', title: 'A' },
    { id: 20, windowId: 2, url: 'https://x.example/', title: 'X' },
    { id: 21, windowId: 2, url: 'https://y.example/', title: 'Y' },
  )
  await settled()

  fake.activate(21)
  await settled()

  expect(pages).toEqual([{ url: 'https://a.example/', title: 'A' }])
})
