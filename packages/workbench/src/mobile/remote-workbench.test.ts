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
    async terminal() {
      throw new Error('not used by observation')
    },
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
    async terminal() {
      throw new Error('not used by observation')
    },
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
    async terminal() {
      throw new Error('not used by observation')
    },
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

test('openTerminal waits for replay parsing before draw ACK and close releases only that view', async () => {
  const parsed = Promise.withResolvers<void>()
  const frames = [
    { version: 1, type: 'size', sequence: 1, generation: 0, rows: 31, cols: 97 },
    { version: 1, type: 'output', sequence: 2, data: btoa('tail') },
    { version: 1, type: 'replay_end', sequence: 3 },
    { version: 1, type: 'output', sequence: 4, data: btoa('live') },
    { version: 1, type: 'exit', sequence: 5, exitCode: 0 },
  ]
  const acknowledgements: number[] = []
  const written: string[] = []
  let closes = 0
  const remote = new RemoteWorkbench({
    async read() {
      return []
    },
    async subscribe() {},
    async terminal() {
      return {
        async next() {
          return frames.shift() ?? new Promise(() => {})
        },
        async ack(sequence) {
          acknowledgements.push(sequence)
        },
        async close() {
          closes++
          return true
        },
      }
    },
  })
  const view = remote.openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      size(rows, cols) {
        expect([rows, cols]).toEqual([31, 97])
      },
      async write(bytes) {
        written.push(new TextDecoder().decode(bytes))
        if (written.length === 1) await parsed.promise
      },
      state() {},
    },
  )
  await flush()
  expect(written).toEqual(['tail'])
  expect(acknowledgements).toEqual([1])
  parsed.resolve()
  await flush()
  expect(written).toEqual(['tail', 'live'])
  expect(acknowledgements).toEqual([1, 2, 3, 4, 5])
  expect(await view.close()).toBe(true)
  expect(closes).toBe(1)
})

test('closing a view while its transport opens releases the late stream without parsing or acknowledging it', async () => {
  const opened = Promise.withResolvers<import('./remote-workbench.ts').TerminalStream>()
  let closes = 0
  const remote = new RemoteWorkbench({
    terminal: () => opened.promise,
    async read() {
      return []
    },
    async subscribe() {},
  })
  const view = remote.openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      async write() {
        throw new Error('closed view rendered')
      },
      size() {
        throw new Error('closed view resized')
      },
      state() {},
    },
  )
  const closed = view.close()
  opened.resolve({
    async next() {
      throw new Error('closed view read')
    },
    async ack() {
      throw new Error('closed view acknowledged')
    },
    async close() {
      closes++
      return true
    },
  })
  expect(await closed).toBe(true)
  expect(closes).toBe(1)
})

test('a late parse callback after close cannot acknowledge output or reopen its view', async () => {
  const parsing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const acknowledgements: number[] = []
  const remote = new RemoteWorkbench({
    async terminal() {
      return {
        async next() {
          return { version: 1, type: 'output', sequence: 1, data: btoa('tail') }
        },
        async ack(sequence) {
          acknowledgements.push(sequence)
        },
        async close() {
          return true
        },
      }
    },
    async read() {
      return []
    },
    async subscribe() {},
  })
  const view = remote.openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      async write() {
        parsing.resolve()
        await release.promise
      },
      size() {},
      state() {},
    },
  )
  await parsing.promise
  expect(await view.close()).toBe(true)
  release.resolve()
  await flush()
  expect(acknowledgements).toEqual([])
})
