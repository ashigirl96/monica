import { expect, test } from 'bun:test'

import { type ZoomKey, zoomStepOf } from './text-zoom.ts'

const key = (k: Partial<ZoomKey>): ZoomKey => ({
  key: '',
  code: '',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...k,
})

test('⌘+ と JIS の ⌘; とテンキーの + で拡大し、⌘- で縮め、⌘0 で戻す', () => {
  expect(zoomStepOf(key({ key: '+' }))).toBe('in')
  expect(zoomStepOf(key({ key: '=' }))).toBe('in')
  expect(zoomStepOf(key({ key: ';' }))).toBe('in')
  expect(zoomStepOf(key({ code: 'NumpadAdd' }))).toBe('in')
  expect(zoomStepOf(key({ key: '-' }))).toBe('out')
  expect(zoomStepOf(key({ key: '0' }))).toBe('reset')
  expect(zoomStepOf(key({ key: '=', metaKey: false, ctrlKey: true }))).toBe('in')
})

test('⌘ も ⌃ も無いキーと、⌥ を伴うキーは取らない', () => {
  expect(zoomStepOf(key({ key: '+', metaKey: false }))).toBeNull()
  expect(zoomStepOf(key({ key: '=', altKey: true }))).toBeNull()
  expect(zoomStepOf(key({ key: 'a' }))).toBeNull()
})
