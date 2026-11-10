import { expect, test } from 'bun:test'

import { isNewConversationKey, type KeyPress } from './new-conversation-key.ts'

const press = (init: Partial<KeyPress>): KeyPress => ({
  code: 'KeyN',
  key: 'Dead',
  altKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...init,
})

test.each<[string, Partial<KeyPress>, boolean]>([
  ['⌥N that macOS turns into a dead key', {}, true],
  ['N without ⌥', { altKey: false, key: 'n' }, false],
  ['⌘⌥N', { metaKey: true }, false],
  ['⌃⌥N', { ctrlKey: true }, false],
  ['⇧⌥N', { shiftKey: true }, false],
  ['⌥N while composing', { isComposing: true }, false],
  ['⌥M', { code: 'KeyM' }, false],
])('%s → %p', (_, init, expected) => {
  expect(isNewConversationKey(press(init))).toBe(expected)
})
