import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { type SlotPage, slotPageOf } from './slots.ts'

const everywhere: SlotPage = () => <p>dummy</p>

test('a path of note stays the page of note even when the slot draws every path', () => {
  for (const pathname of [
    '/',
    '/daily/2026-10-06',
    '/pad',
    '/essays',
    '/essays/note-7',
    '/repos',
    '/repos/acme/app',
    '/notes/note-7',
  ]) {
    expect(slotPageOf(pathname, everywhere)).toBeNull()
  }
})

test('a path note does not know becomes the page of the slot', () => {
  const page = slotPageOf('/dummy/1', everywhere)

  expect(page).not.toBeNull()
  expect(renderToStaticMarkup(page!)).toBe('<p>dummy</p>')
})

test('a path the slot does not draw, or no slot, falls to the Not found of note', () => {
  expect(slotPageOf('/dummy/1', () => null)).toBeNull()
  expect(slotPageOf('/dummy/1', undefined)).toBeNull()
})
