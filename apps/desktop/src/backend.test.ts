import { afterEach, expect, mock, test } from 'bun:test'

type Answer = { endpoint: { port: number; token: string } | null; failed: boolean }

let answer = Promise.withResolvers<Answer>()
const asked: string[] = []
const listeners = new Map<string, (event: { payload: unknown }) => void>()

const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: (command: string) => {
    asked.push(`${command} after ${[...listeners.keys()].toSorted().join(', ')}`)
    return answer.promise
  },
}))
const tauriEvent = await import('@tauri-apps/api/event')
await mock.module('@tauri-apps/api/event', () => ({
  ...tauriEvent,
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}))

const { watchBackend } = await import('./backend.ts')

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  answer = Promise.withResolvers<Answer>()
  asked.length = 0
  listeners.clear()
})

function watch() {
  const endpoints: unknown[] = []
  let failed = 0
  stops.push(
    watchBackend({
      onEndpoint: (endpoint) => endpoints.push(endpoint),
      onFailed: () => failed++,
    }),
  )
  return { endpoints, failed: () => failed }
}

async function untilAsked() {
  while (asked.length === 0) await Bun.sleep(1)
}

test('an endpoint the Shell sends before it answers backend_endpoint is kept over the answer', async () => {
  const watched = watch()
  await untilAsked()

  listeners.get('backend-endpoint')?.({ payload: { port: 2, token: 'new' } })
  answer.resolve({ endpoint: { port: 1, token: 'old' }, failed: false })
  await Bun.sleep(10)

  expect(asked).toEqual(['backend_endpoint after backend-endpoint, backend-failed'])
  expect(watched.endpoints).toEqual([{ port: 2, token: 'new' }])
})

test('a Backend the Shell gave up on shows as failed from the answer, even when backend-failed was missed', async () => {
  const watched = watch()
  await untilAsked()

  answer.resolve({ endpoint: null, failed: true })
  await Bun.sleep(10)

  expect(watched.endpoints).toEqual([null])
  expect(watched.failed()).toBe(1)
})
