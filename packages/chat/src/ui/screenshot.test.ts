import { afterEach, expect, spyOn, test } from 'bun:test'

import { FakeChrome } from './fake-chrome.ts'
import { shrunkSize, takeScreenshot } from './screenshot.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test('a screenshot taken at a device pixel ratio of 2 shrinks to half its pixels, the CSS pixels of the Browser Tab', () => {
  expect(shrunkSize({ width: 1724, height: 1526 }, 2)).toEqual({ width: 862, height: 763 })
})

test('a screenshot taken at a device pixel ratio of 1 keeps its size', () => {
  expect(shrunkSize({ width: 862, height: 763 }, 1)).toEqual({ width: 862, height: 763 })
})

test('a fractional device pixel ratio rounds to whole pixels', () => {
  expect(shrunkSize({ width: 1293, height: 1145 }, 1.5)).toEqual({ width: 862, height: 763 })
})

// side panel だけを縮めて表示しているときも、撮った画像より大きくしない。
test('a device pixel ratio below 1 does not enlarge the screenshot', () => {
  expect(shrunkSize({ width: 862, height: 763 }, 0.5)).toEqual({ width: 862, height: 763 })
})

test('a screenshot that does not come within 3 seconds is given up', async () => {
  const fake = new FakeChrome(1, [{ id: 10, windowId: 1, url: 'https://coast.example/' }])
  fake.install()
  cleanups.push(() => fake.uninstall())
  fake.screenshots.set(10, 'hang')
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
  cleanups.push(() => setTimeoutSpy.mockRestore())

  const taking = takeScreenshot(1)
  const [[giveUp, ms]] = setTimeoutSpy.mock.calls as [[() => void, number]]
  giveUp()

  expect(ms).toBe(3000)
  expect(await taking).toEqual({
    screenshotFailed: { reason: 'the Browser Tab did not answer within 3 seconds' },
  })
})
