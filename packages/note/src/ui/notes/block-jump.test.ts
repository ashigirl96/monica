import { expect, mock, test } from 'bun:test'

import { arrivalAt, jumpToBlock } from './block-jump.ts'

function view() {
  return { scrollToBlock: mock((_blockId: string) => {}), openNote: mock((_noteId: string) => {}) }
}

test('a jump to a block of the open Note scrolls to it there and leaves nothing for a later arrival', () => {
  const editor = view()

  jumpToBlock({ noteId: 'note-3', blockId: 'b1' }, 'note-3', editor)

  expect(editor.scrollToBlock.mock.calls).toEqual([['b1']])
  expect(editor.openNote).not.toHaveBeenCalled()
  expect(arrivalAt('note-3')()).toBeNull()
})

test('a jump to a block of another Note opens that Note, which finds the block on arriving, every time the effect asks', () => {
  const editor = view()

  jumpToBlock({ noteId: 'note-7', blockId: 'b2' }, 'note-3', editor)

  expect(editor.openNote.mock.calls).toEqual([['note-7']])
  expect(editor.scrollToBlock).not.toHaveBeenCalled()
  const arrival = arrivalAt('note-7')
  expect(arrival()).toBe('b2')
  expect(arrival()).toBe('b2')
  expect(arrivalAt('note-7')()).toBeNull()
})

test('arriving at another Note on the way leaves the block for the Note it is in', () => {
  jumpToBlock({ noteId: 'note-7', blockId: 'b2' }, 'note-3', view())

  expect(arrivalAt('note-5')()).toBeNull()
  expect(arrivalAt('note-7')()).toBe('b2')
})
