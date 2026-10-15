import { afterEach, expect, mock, test } from 'bun:test'

import { QueryObserver } from '@tanstack/react-query'

import { createQueryClient } from './query.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function fakeBrowser(): EventTarget {
  const window = new EventTarget()
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: 'visible' },
    configurable: true,
  })
  cleanups.push(() => {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  })
  return window
}

async function fetchedTimes(queryFn: { mock: { calls: unknown[] } }, times: number) {
  for (let i = 0; i < 100 && queryFn.mock.calls.length < times; i++) await Bun.sleep(1)
  return queryFn.mock.calls.length
}

test('a query is fetched again every time the window gets focus back after losing it', async () => {
  const window = fakeBrowser()
  const client = createQueryClient()
  client.mount()
  cleanups.push(() => client.unmount())
  const queryFn = mock(() => Promise.resolve('essays'))
  const observer = new QueryObserver(client, { queryKey: ['essays'], queryFn })
  cleanups.push(observer.subscribe(() => {}))

  expect(await fetchedTimes(queryFn, 1)).toBe(1)

  window.dispatchEvent(new Event('blur'))
  window.dispatchEvent(new Event('focus'))
  expect(await fetchedTimes(queryFn, 2)).toBe(2)

  window.dispatchEvent(new Event('blur'))
  window.dispatchEvent(new Event('focus'))
  expect(await fetchedTimes(queryFn, 3)).toBe(3)
})
