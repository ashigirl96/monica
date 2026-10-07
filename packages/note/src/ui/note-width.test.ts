import { afterEach, expect, test } from 'bun:test'

import { closePage, FakeStorage, openPage } from './fake-browser.ts'
import { noteWidthPref, setNoteWidthPref } from './note-width.ts'

afterEach(closePage)

test('選んだ本文の幅は localStorage の tania-note-extra-w に残り、次に開いたときに読まれる', () => {
  const storage = new FakeStorage()
  openPage(storage)
  setNoteWidthPref(80)
  expect([...storage.items]).toEqual([['tania-note-extra-w', '80']])

  openPage(storage)
  expect(noteWidthPref()).toBe(80)
})
