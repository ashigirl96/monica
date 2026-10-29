import { expect, spyOn, test } from 'bun:test'

import { observeRegistration, observeForeground, scanRegistration } from './native.ts'

test('registration retries a temporary native failure but stops after approval and discards cancelled results', async () => {
  let retry: (() => void) | undefined
  let calls = 0
  const states: string[] = []
  const previous = globalThis.window
  globalThis.window = {
    webkit: {
      messageHandlers: {
        monica: {
          async postMessage(message: { operation: string }) {
            if (message.operation === 'registration-approved') return { state: 'ok', value: null }
            calls++
            return calls === 1
              ? { state: 'unavailable' }
              : {
                  state: 'ok',
                  value: {
                    state: 'approved',
                    version: 1,
                    id: '0',
                    lifecycle: 'pending',
                    pendingUntil: 0,
                  },
                }
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
    retry?.()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls).toBe(2)
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

test('only an unauthorized pending registration expires; approved and legacy credentials require approval instead', async () => {
  const previous = globalThis.window
  const states: string[] = []
  const completions: (() => void)[] = []
  let reply: unknown
  globalThis.window = {
    webkit: {
      messageHandlers: {
        monica: {
          async postMessage() {
            return { state: 'ok', value: reply }
          },
        },
      },
    },
  } as unknown as Window & typeof globalThis
  try {
    for (const lifecycle of ['pending', 'approved', 'unknown']) {
      reply = { state: 'unauthorized', id: '0', lifecycle, pendingUntil: 0 }
      const complete = Promise.withResolvers<void>()
      completions.push(
        observeRegistration(
          (state) => {
            states.push(state)
            complete.resolve()
          },
          (error) => {
            states.push(error.state)
            complete.resolve()
          },
        ),
      )
      await complete.promise
    }
    expect(states).toEqual(['expired', 'revoked', 'approval-required'])
  } finally {
    for (const stop of completions) stop()
    globalThis.window = previous
  }
})

test('scan cancellation is a no-op and invitation expiry is decided before replacing registration', async () => {
  const previous = globalThis.window
  let reply: unknown
  const operations: string[] = []
  globalThis.window = {
    webkit: {
      messageHandlers: {
        monica: {
          async postMessage(message: { operation: string }) {
            operations.push(message.operation)
            return { state: 'ok', value: reply }
          },
        },
      },
    },
  } as unknown as Window & typeof globalThis
  try {
    reply = { state: 'cancelled' }
    expect(await scanRegistration()).toBe('cancelled')
    reply = { state: 'candidate', expiresAt: 0 }
    expect(await scanRegistration()).toBe('expired')
    reply = { state: 'candidate', expiresAt: Date.now() + 60_000 }
    expect(await scanRegistration()).toBe('ready')
    reply = { state: 'candidate', expiresAt: Date.now() + 600_000 }
    await expect(scanRegistration()).rejects.toMatchObject({ state: 'incompatible' })
    expect(operations).toEqual(['scan', 'scan', 'scan', 'scan'])
  } finally {
    globalThis.window = previous
  }
})

test('native foreground events supersede a late initial lifecycle reply and release their listener', async () => {
  const previous = globalThis.window
  const initial = Promise.withResolvers<unknown>()
  const target = new EventTarget()
  const states: boolean[] = []
  globalThis.window = Object.assign(target, {
    webkit: { messageHandlers: { monica: { postMessage: () => initial.promise } } },
  }) as unknown as Window & typeof globalThis
  try {
    const stop = observeForeground((value) => states.push(value))
    target.dispatchEvent(new CustomEvent('monica-foreground', { detail: false }))
    target.dispatchEvent(new CustomEvent('monica-foreground', { detail: true }))
    initial.resolve({ state: 'ok', value: false })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(states).toEqual([false, true])
    stop()
    target.dispatchEvent(new CustomEvent('monica-foreground', { detail: false }))
    expect(states).toEqual([false, true])
  } finally {
    globalThis.window = previous
  }
})
