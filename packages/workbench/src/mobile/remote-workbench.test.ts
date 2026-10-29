import { expect, test } from 'bun:test'

import { RemoteWorkbench, type RemoteState, type RemoteTransport } from './remote-workbench.ts'

const empty = { runspaces: [] }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('observe waits for subscription acknowledgement and refreshes again for changes during a snapshot', async () => {
  const ack = Promise.withResolvers<void>()
  const first = Promise.withResolvers<unknown>()
  let change: (() => void) | undefined
  const calls: string[] = []
  const transport: RemoteTransport = {
    async subscribe(changed) {
      change = changed
      await ack.promise
    },
    async read(procedure) {
      calls.push(procedure)
      if (procedure === 'layout/get') return calls.length === 1 ? first.promise : empty
      return []
    },
  }
  const states: RemoteState[] = []
  const stop = new RemoteWorkbench(transport).observe((state) => states.push(state))
  await flush()
  expect(calls).toEqual([])
  ack.resolve()
  await flush()
  change?.()
  first.resolve(empty)
  await flush()
  expect(calls.filter((path) => path === 'layout/get')).toHaveLength(2)
  expect(states.at(-1)).toMatchObject({ state: 'available', layout: empty })
  stop()
})

test('closing an observation aborts its subscription and discards a late snapshot from that generation', async () => {
  const layout = Promise.withResolvers<unknown>()
  let subscribed: AbortSignal | undefined
  const states: RemoteState[] = []
  const transport: RemoteTransport = {
    async subscribe(_changed, signal) {
      subscribed = signal
    },
    async read(procedure) {
      return procedure === 'layout/get' ? layout.promise : []
    },
  }
  const remote = new RemoteWorkbench(transport)
  const stop = remote.observe((state) => states.push(state))
  await flush()
  stop()
  expect(subscribed?.aborted).toBe(true)
  const before = states.length
  layout.resolve(empty)
  await flush()
  expect(states).toHaveLength(before)
})

test('an incompatible snapshot clears availability and aborts the installed subscription', async () => {
  let signal: AbortSignal | undefined
  const states: RemoteState[] = []
  const complete = Promise.withResolvers<void>()
  const stop = new RemoteWorkbench({
    async subscribe(_changed, subscribed) {
      signal = subscribed
    },
    async read() {
      return { incompatible: true }
    },
  }).observe((state) => {
    states.push(state)
    if (state.state === 'incompatible') complete.resolve()
  })
  await complete.promise
  expect(states.at(-1)).toEqual({ state: 'incompatible' })
  expect(signal?.aborted).toBe(true)
  stop()
})
