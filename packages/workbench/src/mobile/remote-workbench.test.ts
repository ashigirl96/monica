import { expect, spyOn, test } from 'bun:test'

import type { TerminalInput } from '../remote-terminal.ts'
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
        async prepare() {},
        async input() {},
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
    async prepare() {},
    async input() {},
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
        async prepare() {},
        async input() {},
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

test('input is not queued before ready, is bounded in decoded bytes, and a lost ACK is uncertain without retry', async () => {
  const frames: unknown[] = []
  let receive: ((frame: unknown) => void) | undefined
  const sends: unknown[] = []
  const push = (frame: unknown) => {
    if (receive) {
      const next = receive
      receive = undefined
      next(frame)
    } else frames.push(frame)
  }
  const remote = new RemoteWorkbench({
    async read() {
      return []
    },
    async subscribe() {},
    async terminal() {
      return {
        async next() {
          return frames.length
            ? frames.shift()
            : new Promise((resolve) => {
                receive = resolve
              })
        },
        async ack() {},
        async prepare() {},
        async input(command) {
          sends.push(command)
          throw new Error('ACK lost after send')
        },
        async close() {
          return true
        },
      }
    },
  })
  const view = remote.openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      async write() {},
      size() {},
      state() {},
    },
  )
  expect(await view.input(new TextEncoder().encode('before'))).toBe('not-sent')
  push({ version: 1, type: 'replay_end', sequence: 1 })
  push({ version: 1, type: 'renderer', generation: { renderer: 1, connection: 2 } })
  await flush()
  expect(await view.input(new Uint8Array(65537))).toBe('not-sent')
  expect(await view.input(new TextEncoder().encode('command\r'))).toBe('uncertain')
  expect(await view.input(new TextEncoder().encode('later'))).toBe('not-sent')
  expect(sends).toHaveLength(1)
  await view.close()
})

function inputFixture(input: (command: TerminalInput) => Promise<void>) {
  const frames: unknown[] = [
    { version: 1, type: 'replay_end', sequence: 1 },
    { version: 1, type: 'renderer', generation: { renderer: 1, connection: 2 } },
  ]
  let receive: ((frame: unknown) => void) | undefined
  const ready: boolean[] = []
  const view = new RemoteWorkbench({
    async read() {
      return []
    },
    async subscribe() {},
    async terminal() {
      return {
        async prepare() {},
        input,
        async next() {
          return frames.length
            ? frames.shift()
            : new Promise((resolve) => {
                receive = resolve
              })
        },
        async ack() {},
        async close() {
          return true
        },
      }
    },
  }).openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      async write() {},
      size() {},
      state() {},
      inputReady(value) {
        ready.push(value)
      },
    },
  )
  return {
    view,
    ready,
    result: (id: number, result: 'accepted' | 'not-sent') => {
      const frame = { version: 1, type: 'input_result', id, result }
      if (receive) {
        const next = receive
        receive = undefined
        next(frame)
      } else frames.push(frame)
    },
  }
}

test('input returns uncertain at the deadline even when sending never settles, and never retries', async () => {
  const sends: TerminalInput[] = []
  const { view, ready } = inputFixture((command) => {
    sends.push(command)
    return new Promise(() => {})
  })
  await flush()
  expect(ready.at(-1)).toBe(true)
  let expire: (() => void) | undefined
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    expect(delay).toBe(6000)
    expire = callback
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  try {
    let result: string | undefined
    const sending = view.input(new TextEncoder().encode('command\r')).then((value) => {
      result = value
    })
    expect(sends).toHaveLength(1)
    expect(await view.input(new TextEncoder().encode('concurrent'))).toBe('not-sent')
    expect(expire).toBeDefined()
    expire!()
    await flush()
    expect(result).toBe('uncertain')
    await sending
    expect(ready.at(-1)).toBe(false)
    expect(await view.input(new TextEncoder().encode('later'))).toBe('not-sent')
    expect(sends).toHaveLength(1)
  } finally {
    await view.close()
    timer.mockRestore()
  }
})

test('a late send rejection and expired timer cannot finish a newer input ID', async () => {
  const first = Promise.withResolvers<void>()
  const sends: TerminalInput[] = []
  const { view, ready, result } = inputFixture((command) => {
    sends.push(command)
    return sends.length === 1 ? first.promise : Promise.resolve()
  })
  await flush()
  const expires: (() => void)[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    expect(delay).toBe(6000)
    expires.push(callback)
    return expires.length as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  try {
    let firstResult: string | undefined
    const sending = view.input(new TextEncoder().encode('first')).then((value) => {
      firstResult = value
    })
    result(1, 'accepted')
    await flush()
    expect(firstResult).toBe('accepted')
    await sending
    let secondResult: string | undefined
    const second = view.input(new TextEncoder().encode('second')).then((value) => {
      secondResult = value
    })
    first.reject(new Error('late send failure after ACK'))
    expires[0]!()
    await flush()
    expect(secondResult).toBeUndefined()
    expect(ready.at(-1)).toBe(true)
    result(2, 'not-sent')
    await second
    expect(secondResult).toBe('not-sent')
    expect(sends.map(({ id }) => id)).toEqual([1, 2])
  } finally {
    await view.close()
    timer.mockRestore()
  }
})

test('paste preflights the entire UTF-8 limit then preserves byte boundaries and excludes other input until every ACK', async () => {
  const sends: TerminalInput[] = []
  const { view, result } = inputFixture(async (command) => {
    sends.push(command)
  })
  await flush()
  expect(await view.paste('あ'.repeat(87382))).toEqual({
    result: 'not-sent',
    acceptedBytes: 0,
    totalBytes: 262146,
  })
  expect(await view.paste('x'.repeat(262145))).toEqual({
    result: 'not-sent',
    acceptedBytes: 0,
    totalBytes: 262145,
  })
  expect(await view.paste('')).toEqual({ result: 'not-sent', acceptedBytes: 0, totalBytes: 0 })
  expect(sends).toEqual([])
  const text = 'x'.repeat(65535) + '😀' + 'あ'.repeat(65535) // exactly 256 KiB, with a split emoji
  const paste = view.paste(text)
  expect(sends).toHaveLength(1)
  expect(await view.input(new Uint8Array([3]))).toBe('not-sent')
  expect((await view.paste('concurrent')).result).toBe('not-sent')
  for (let id = 1; id <= 4; id++) {
    expect(sends).toHaveLength(id)
    expect(atob(sends[id - 1]!.data)).toHaveLength(65536)
    result(id, 'accepted')
    await flush()
  }
  expect(await paste).toEqual({ result: 'accepted', acceptedBytes: 262144, totalBytes: 262144 })
  const bytes = Buffer.concat(sends.map(({ data }) => Buffer.from(data, 'base64')))
  expect(bytes.equals(Buffer.from(text))).toBe(true)
  await view.close()
})

test('a paste stops at a refused chunk, reports the accepted prefix as partial uncertain delivery, and never sends the remainder', async () => {
  const sends: TerminalInput[] = []
  const { view, result, ready } = inputFixture(async (command) => {
    sends.push(command)
  })
  await flush()
  const paste = view.paste('a'.repeat(131073))
  result(1, 'accepted')
  await flush()
  result(2, 'not-sent')
  expect(await paste).toEqual({ result: 'uncertain', acceptedBytes: 65536, totalBytes: 131073 })
  expect(sends).toHaveLength(2)
  expect(ready.at(-1)).toBe(false)
  expect(await view.input(new Uint8Array([13]))).toBe('not-sent')
  await view.close()
})

test('closing during a paste makes only its in-flight chunk uncertain and never retries any remainder', async () => {
  const sends: TerminalInput[] = []
  const { view, result } = inputFixture(async (command) => {
    sends.push(command)
  })
  expect(await view.paste('before-ready')).toEqual({
    result: 'not-sent',
    acceptedBytes: 0,
    totalBytes: 12,
  })
  await flush()
  const paste = view.paste('a'.repeat(131073))
  result(1, 'accepted')
  await flush()
  await view.close()
  expect(await paste).toEqual({ result: 'uncertain', acceptedBytes: 65536, totalBytes: 131073 })
  expect(sends).toHaveLength(2)
})
