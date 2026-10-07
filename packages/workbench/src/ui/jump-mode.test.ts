import { expect, test } from 'bun:test'

import { handleJumpMode, type JumpModeActions } from './jump-mode.ts'

function press(key: string, closing: boolean): string[] {
  const calls: string[] = []
  const actions: JumpModeActions = {
    deactivate: () => calls.push('deactivate'),
    createTab: () => calls.push('createTab'),
    closeTab: () => calls.push('closeTab'),
    jumpToHint: ({ key: hint }) => calls.push(`jumpToHint:${hint}`),
    moveActiveTab: (direction) => calls.push(`moveActiveTab:${direction}`),
    moveActiveRunspace: (direction) => calls.push(`moveActiveRunspace:${direction}`),
  }
  const event = { key, ctrlKey: false, preventDefault: () => {} } as KeyboardEvent
  handleJumpMode(event, actions, { closing })
  return calls
}

test('d closes the active Tab', () => {
  expect(press('d', false)).toEqual(['closeTab'])
})

test('while a Tab waits for the second d, d closes it and any other key leaves jump mode doing nothing else', () => {
  expect(press('d', true)).toEqual(['closeTab'])
  expect(press('c', true)).toEqual(['deactivate'])
  expect(press('2', true)).toEqual(['deactivate'])
  expect(press('Escape', true)).toEqual(['deactivate'])
  expect(press('Shift', true)).toEqual([])
})
