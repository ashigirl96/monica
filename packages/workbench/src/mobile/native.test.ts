import { expect, spyOn, test } from 'bun:test'

import { observeRegistration } from './native.ts'

test('registration retries a temporary native failure but stops after approval and discards cancelled results', async () => {
  let retry: (() => void) | undefined
  let calls = 0
  const states: string[] = []
  const previous = globalThis.window
  globalThis.window = {
    webkit: {
      messageHandlers: {
        monica: {
          async postMessage() {
            calls++
            return calls === 1 ? { state: 'unavailable' } : { state: 'ok', value: 'approved' }
          },
        },
      },
    },
  } as unknown as Window & typeof globalThis
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    expect(Number(delay)).toBeGreaterThanOrEqual(500)
    expect(Number(delay)).toBeLessThanOrEqual(600)
    retry = callback
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  try {
    const stop = observeRegistration(
      (state) => states.push(state),
      (error) => states.push(error.state),
    )
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(states).toEqual(['unavailable'])
    retry?.()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(states).toEqual(['unavailable', 'approved'])
    stop()
    const cancel = observeRegistration(
      (state) => states.push(state),
      (error) => states.push(error.state),
    )
    cancel()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(states).toEqual(['unavailable', 'approved'])
  } finally {
    timer.mockRestore()
    globalThis.window = previous
  }
})
