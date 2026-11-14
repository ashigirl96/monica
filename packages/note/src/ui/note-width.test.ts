import { afterEach, expect, test } from 'bun:test'

import { setWidthPref, widthPref } from '@monica/ui'

import { closePage, FakeStorage, openPage } from './fake-browser.ts'
import { NOTE_WIDTH } from './note-width.ts'

afterEach(closePage)

test('選んだ本文の幅は localStorage の monica-note-extra-w に残り、次に開いたときに読まれる', () => {
  const storage = new FakeStorage()
  openPage(storage)
  setWidthPref(NOTE_WIDTH, 80)
  expect([...storage.items]).toEqual([['monica-note-extra-w', '80']])

  openPage(storage)
  expect(widthPref(NOTE_WIDTH)).toBe(80)
})
