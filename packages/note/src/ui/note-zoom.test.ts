import { afterEach, expect, test } from 'bun:test'

import { nextZoom } from '@monica/ui'

import { closePage, FakeStorage, openPage } from './fake-browser.ts'
import { noteZoomPref } from './note-zoom.ts'

afterEach(closePage)

test('1 段拡大し、1 段縮め、元に戻すと 1 になる', () => {
  expect(nextZoom(1, 'in')).toBe(1.1)
  expect(nextZoom(1, 'out')).toBe(0.9)
  expect(nextZoom(1.5, 'reset')).toBe(1)
})

test('拡大率は両端の段で止まる', () => {
  expect(nextZoom(3, 'in')).toBe(3)
  expect(nextZoom(0.5, 'out')).toBe(0.5)
})

test('localStorage の段に無い拡大率は 1 として読む', () => {
  openPage(new FakeStorage({ 'monica-note-zoom': '1.33' }))
  expect(noteZoomPref()).toBe(1)
  openPage(new FakeStorage({ 'monica-note-zoom': '1.25' }))
  expect(noteZoomPref()).toBe(1.25)
})
