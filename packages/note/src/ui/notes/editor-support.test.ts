import { expect, test } from 'bun:test'

import type { NoteClient } from '../client.ts'
import { cycleSelect, imageCallbacks } from './editor-support.ts'

const days = ['2026-10-07', '2026-10-06', '2026-10-01']

test('cycling moves one row and wraps around at either end', () => {
  expect(cycleSelect(days, '2026-10-06', 1)).toBe('2026-10-01')
  expect(cycleSelect(days, '2026-10-01', 1)).toBe('2026-10-07')
  expect(cycleSelect(days, '2026-10-07', -1)).toBe('2026-10-01')
})

test('from a row outside the list, cycling forward opens the first row and back the last', () => {
  expect(cycleSelect(days, '2026-09-01', 1)).toBe('2026-10-07')
  expect(cycleSelect(days, null, -1)).toBe('2026-10-01')
  expect(cycleSelect([], null, 1)).toBeUndefined()
})

function clientAnswering(answer: () => Promise<{ url: string }>) {
  const calls: unknown[] = []
  const call = (input: unknown) => {
    calls.push(input)
    return answer()
  }
  return { calls, client: { image: { upload: call, import: call } } as unknown as NoteClient }
}

test('the editor is handed the URL of a placed image, and null when the Backend refuses or is unreachable', async () => {
  const file = new File(['png'], 'pasted.png')
  const placed = clientAnswering(async () => ({ url: '/api/assets/a.png' }))
  const refused = clientAnswering(() => Promise.reject(new Error('UNSUPPORTED_MEDIA_TYPE')))

  expect(await imageCallbacks(placed.client).uploadImage(file)).toEqual({
    url: '/api/assets/a.png',
  })
  expect(await imageCallbacks(placed.client).importExternalImage('https://x/a.png')).toEqual({
    url: '/api/assets/a.png',
  })
  expect(placed.calls).toEqual([{ file }, { url: 'https://x/a.png' }])
  expect(await imageCallbacks(refused.client).uploadImage(file)).toBeNull()
  expect(await imageCallbacks(refused.client).importExternalImage('https://x/a.png')).toBeNull()
})
