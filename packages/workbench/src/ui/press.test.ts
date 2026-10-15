import { expect, mock, test } from 'bun:test'

import type { MouseEvent, PointerEvent } from 'react'

import { pointerPress, pressHandlers } from './press.ts'

function mouse(init: { button?: number; detail?: number }) {
  const preventDefault = mock(() => {})
  return {
    event: { button: 0, detail: 1, ...init, preventDefault } as unknown as MouseEvent,
    preventDefault,
  }
}

test("pressing a row, a section header, or the Tile for outside the Repos keeps the terminal's focus", () => {
  const down = mouse({})
  pressHandlers(() => {}).onMouseDown(down.event)
  expect(down.preventDefault).toHaveBeenCalled()

  const pointer = mouse({})
  pointerPress(() => {}).onPointerDown(pointer.event as unknown as PointerEvent)
  expect(pointer.preventDefault).toHaveBeenCalled()
})

test('a press acts on mousedown, and a click acts only when it comes from the keyboard', () => {
  const action = mock(() => {})
  const handlers = pressHandlers(action)

  handlers.onMouseDown(mouse({ button: 0 }).event)
  expect(action).toHaveBeenCalledTimes(1)

  handlers.onClick(mouse({ detail: 1 }).event)
  expect(action).toHaveBeenCalledTimes(1)

  handlers.onClick(mouse({ detail: 0 }).event)
  expect(action).toHaveBeenCalledTimes(2)
})
