import { afterEach, expect, test } from 'bun:test'

import { closePage, FakeStorage, openPage } from './fake-browser.ts'
import { nextNoteZoom, noteZoomPref } from './note-zoom.ts'

afterEach(closePage)

const key = (init: Partial<KeyboardEvent>) => ({ key: '', code: '', ...init }) as KeyboardEvent

test('⌘= と JIS 配列の ⌘; で 1 段拡大し、⌘- で 1 段縮め、⌘0 で 1 に戻す', () => {
  expect(nextNoteZoom(1, key({ metaKey: true, key: '=' }))).toBe(1.1)
  expect(nextNoteZoom(1, key({ metaKey: true, key: ';' }))).toBe(1.1)
  expect(nextNoteZoom(1, key({ metaKey: true, key: '-' }))).toBe(0.9)
  expect(nextNoteZoom(1.5, key({ metaKey: true, key: '0' }))).toBe(1)
})

test('拡大率は両端の段で止まる', () => {
  expect(nextNoteZoom(3, key({ metaKey: true, key: '=' }))).toBe(3)
  expect(nextNoteZoom(0.5, key({ metaKey: true, key: '-' }))).toBe(0.5)
})

test('⌘ を伴わないキーと ⌥ を伴うキーは拡大縮小に使わない', () => {
  expect(nextNoteZoom(1, key({ key: '=' }))).toBeNull()
  expect(nextNoteZoom(1, key({ metaKey: true, altKey: true, key: '=' }))).toBeNull()
})

test('localStorage の段に無い拡大率は 1 として読む', () => {
  openPage(new FakeStorage({ 'monica-note-zoom': '1.33' }))
  expect(noteZoomPref()).toBe(1)
  openPage(new FakeStorage({ 'monica-note-zoom': '1.25' }))
  expect(noteZoomPref()).toBe(1.25)
})
