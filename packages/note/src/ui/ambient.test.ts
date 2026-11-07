import { afterEach, expect, test } from 'bun:test'

import {
  type AmbientName,
  ambientPref,
  ambientStepOf,
  cycleAmbient,
  setAmbientPref,
} from './ambient.ts'
import { closePage, FakeStorage, openPage } from './fake-browser.ts'

afterEach(closePage)

test('選んだ ambient は localStorage の monica-ambient に残り、次に開いたときに読まれる', () => {
  const storage = new FakeStorage()
  openPage(storage)
  setAmbientPref('sakura')
  expect([...storage.items]).toEqual([['monica-ambient', 'sakura']])

  openPage(storage)
  expect(ambientPref()).toBe('sakura')
})

test.each<[string | null, AmbientName]>([
  [null, 'universe'],
  ['none', 'none'],
  ['ink', 'ink'],
  ['shrine', 'shrine'],
  ['aurora', 'universe'],
  // Object の prototype の名前を ambient として読むと、写真を当てるところで throw して画面が描かれない。
  ['constructor', 'universe'],
  ['__proto__', 'universe'],
  ['toString', 'universe'],
])('保存した値が %p なら %s を開く', (saved, expected) => {
  openPage(new FakeStorage(saved === null ? {} : { 'monica-ambient': saved }))
  expect(ambientPref()).toBe(expected)
})

test.each<[string, boolean, 1 | -1]>([
  ['⌥;', false, 1],
  ['⇧⌥;', true, -1],
])('%s で巡る向きは %p', (_, shift, expected) => {
  expect(ambientStepOf({ shift })).toBe(expected)
})

test.each<[AmbientName, 1 | -1, AmbientName]>([
  ['none', 1, 'ink'],
  ['ink', 1, 'universe'],
  ['ink', -1, 'none'],
  ['universe', 1, 'sakura'],
  ['shrine', 1, 'none'],
  ['none', -1, 'shrine'],
  ['sakura', -1, 'universe'],
])('%s から %p の向きに巡ると %s', (current, step, expected) => {
  expect(cycleAmbient(current, step)).toBe(expected)
})
