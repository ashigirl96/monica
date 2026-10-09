import { afterEach, expect, test } from 'bun:test'

import { watchCurrentPage } from './current-page.ts'
import { FakeChrome, type FakeImage } from './fake-chrome.ts'
import { readCurrentPage } from './read-current-page.ts'

let fake: FakeChrome
const stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  fake.uninstall()
})

const settled = () => Bun.sleep(0)

/** PDF を読む上限の bytes。HTML のページでは使わない。 */
const PDF_LIMIT = 1024

// side panel は window 1 に載る。
async function watchWindow(devicePixelRatio = 2) {
  fake = new FakeChrome(1, [
    { id: 10, windowId: 1, url: 'https://coast.example/tide-pools', title: 'Tide pools' },
    { id: 20, windowId: 2, url: 'https://other.example/', title: 'Other' },
  ])
  fake.devicePixelRatio = devicePixelRatio
  fake.install()
  fake.readings.set(10, { html: '<body>Tide</body>', selection: '' })
  fake.screenshots.set(10, { width: 1724, height: 1526 })
  fake.screenshots.set(20, { width: 100, height: 100 })
  const watch = watchCurrentPage(() => {})
  stops.push(watch.stop)
  await settled()
  return watch
}

const options = (screenshot: boolean) => ({
  screenshot,
  maxPdfBytes: PDF_LIMIT,
  signal: new AbortController().signal,
})

const imageOf = (screenshot: string | undefined): FakeImage =>
  JSON.parse(atob(screenshot ?? '')) as FakeImage

// gesture の窓（約 5 秒）を executeScript の 3 秒で食わないよう、Browser Tab を読む前に撮る。
test('a screenshot is taken of the window of the side panel before reading the page waits on anything', async () => {
  const watch = await watchWindow()

  const reading = readCurrentPage(watch, options(true)).page
  const capturedAtOnce = [...fake.captures]
  await reading

  expect(capturedAtOnce).toEqual([[1, { format: 'png' }]])
})

test('the screenshot shrinks to the CSS pixels of the side panel and goes as JPEG at quality 0.8 in base64, with the page read as it is', async () => {
  const watch = await watchWindow(2)

  const page = await readCurrentPage(watch, options(true)).page

  expect(imageOf(page.screenshot)).toEqual({
    type: 'image/jpeg',
    quality: 0.8,
    width: 862,
    height: 763,
  })
  expect(page).toMatchObject({
    url: 'https://coast.example/tide-pools',
    content: { kind: 'html', html: '<body>Tide</body>' },
  })
  expect(page).not.toHaveProperty('screenshotFailed')
})

test('no screenshot is taken unless asked for', async () => {
  const watch = await watchWindow()

  const page = await readCurrentPage(watch, options(false)).page

  expect(fake.captures).toEqual([])
  expect(page).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    content: { kind: 'html', html: '<body>Tide</body>' },
  })
})

test('a screenshot that cannot be taken gives its reason and leaves the text of the page as read', async () => {
  const watch = await watchWindow()
  fake.screenshots.set(10, { error: 'Cannot access contents of the page' })

  const page = await readCurrentPage(watch, options(true)).page

  expect(page).toEqual({
    url: 'https://coast.example/tide-pools',
    title: 'Tide pools',
    content: { kind: 'html', html: '<body>Tide</body>' },
    screenshotFailed: { reason: 'Cannot access contents of the page' },
  })
})

test('a page that cannot be read but can be taken a screenshot of carries both', async () => {
  const watch = await watchWindow()
  fake.readings.set(10, { error: 'Frame was removed' })

  const page = await readCurrentPage(watch, options(true)).page

  expect(page.content).toEqual({
    kind: 'unreadable',
    reason: 'restricted',
    detail: 'Frame was removed',
  })
  expect(imageOf(page.screenshot)).toMatchObject({ width: 862, height: 763 })
})

// 読み終える前に止めた質問は、この URL と title で履歴に入る。
test('the URL and title that the side panel shows go with the reading, before the Browser Tab is read', async () => {
  const watch = await watchWindow()
  fake.readings.set(10, 'hang')

  const { shown } = readCurrentPage(watch, options(false))

  expect(shown).toEqual({ url: 'https://coast.example/tide-pools', title: 'Tide pools' })
})
