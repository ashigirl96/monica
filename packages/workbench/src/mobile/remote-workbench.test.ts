import { expect, spyOn, test } from 'bun:test'

import type { TerminalInput } from '../remote-terminal.ts'
import {
  RemoteWorkbench,
  RemoteError,
  type RemoteState,
  type RemoteTransport,
} from './remote-workbench.ts'

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

async function terminalRead(procedure: string) {
  if (procedure === 'layout/get')
    return {
      runspaces: [
        {
          id: 'runspace',
          cwd: '/test',
          sortOrder: 0,
          owned: false,
          tabs: [
            { id: 'tab', cwd: '/test', sortOrder: 0, pinned: false, terminalSessionId: 'session' },
          ],
        },
      ],
    }
  if (procedure === 'terminalSession/list')
    return [
      {
        id: 'session',
        tabId: 'tab',
        cwd: '/test',
        shell: '/bin/sh',
        status: 'running',
        pid: 1,
        exitCode: null,
        error: null,
        createdAt: new Date(),
        endedAt: null,
      },
    ]
  return []
}

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
    read: terminalRead,
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
    read: terminalRead,
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
  await flush()
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
    read: terminalRead,
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
    read: terminalRead,
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
    read: terminalRead,
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

test('foreground discards old subscription ACKs, snapshots and renderer callbacks before a fresh attachment', async () => {
  const subscriptions: {
    signal: AbortSignal
    ack: ReturnType<typeof Promise.withResolvers<void>>
  }[] = []
  const reads: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const streams: {
    frames: unknown[]
    next: ReturnType<typeof Promise.withResolvers<unknown>>
    closes: number
  }[] = []
  const output: string[] = []
  const states: string[] = []
  const readiness: boolean[] = []
  const remote = new RemoteWorkbench({
    subscribe(_changed, signal) {
      const ack = Promise.withResolvers<void>()
      subscriptions.push({ signal, ack })
      return ack.promise
    },
    async read(path) {
      if (path !== 'layout/get') return terminalRead(path)
      const result = Promise.withResolvers<unknown>()
      reads.push(result)
      return result.promise
    },
    async terminal() {
      const stream = {
        frames: [{ version: 1, type: 'replay_end', sequence: 1 }],
        next: Promise.withResolvers<unknown>(),
        closes: 0,
      }
      streams.push(stream)
      return {
        async prepare() {},
        async input() {},
        async ack() {},
        async next() {
          return stream.frames.shift() ?? stream.next.promise
        },
        async close() {
          stream.closes++
          return true
        },
      }
    },
  })
  const stop = remote.observe(() => {})
  const view = remote.openTerminal(
    { tabId: 'tab', terminalSessionId: 'session' },
    {
      async write(bytes) {
        output.push(new TextDecoder().decode(bytes))
      },
      size() {},
      inputReady(value) {
        readiness.push(value)
      },
      state(value) {
        states.push(value)
      },
    },
  )
  expect(subscriptions).toHaveLength(1)
  remote.setForeground(false)
  remote.setForeground(true)
  subscriptions[0]!.ack.resolve()
  await flush()
  expect(reads).toHaveLength(0)
  subscriptions[1]!.ack.resolve()
  await flush()
  remote.setForeground(false)
  remote.setForeground(true)
  reads[0]!.resolve(await terminalRead('layout/get'))
  await flush()
  expect(streams).toHaveLength(0)
  subscriptions[2]!.ack.resolve()
  await flush()
  reads[1]!.resolve(await terminalRead('layout/get'))
  await flush()
  expect(streams).toHaveLength(1)
  remote.setForeground(false)
  expect(streams[0]!.closes).toBe(1)
  remote.setForeground(true)
  subscriptions[3]!.ack.resolve()
  await flush()
  reads[2]!.resolve(await terminalRead('layout/get'))
  await flush()
  streams[0]!.next.resolve({
    version: 1,
    type: 'renderer',
    generation: { renderer: 9, connection: 9 },
  })
  await flush()
  expect(readiness.at(-1)).toBe(false)
  expect(output).toEqual([])
  expect(states.at(-1)).toBe('viewing')
  expect(streams).toHaveLength(2)
  await view.close()
  stop()
  expect(subscriptions.every(({ signal }) => signal.aborted)).toBe(true)
  expect(streams.map(({ closes }) => closes)).toEqual([1, 1])
})

test('only transient failures retry with bounded backoff and foreground cannot resume a revoked identity or incompatible connection', async () => {
  const callbacks: (() => void)[] = []
  const delays: number[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    callbacks.push(callback)
    delays.push(delay)
    return callbacks.length as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  const random = spyOn(Math, 'random').mockReturnValue(0.5)
  try {
    for (const state of [
      'unavailable',
      'revoked',
      'approval-required',
      'identity-changed',
      'incompatible',
    ] as const) {
      let attempts = 0
      const before = callbacks.length
      const remote = new RemoteWorkbench({
        async terminal() {
          throw new Error('never attach')
        },
        read: terminalRead,
        async subscribe() {
          attempts++
          throw new RemoteError(state)
        },
      })
      const stop = remote.observe(() => {})
      await flush()
      if (state === 'unavailable') {
        for (let i = 0; i < 7; i++) {
          callbacks.at(-1)!()
          await flush()
        }
        expect(attempts).toBe(8)
        expect(delays.slice(0, 5)).toEqual([550, 1100, 2200, 4400, 8800])
        expect(delays.slice(5).every((delay) => delay >= 8333 && delay < 10000)).toBe(true)
        remote.setForeground(false)
        const count = attempts
        callbacks.at(-1)!()
        await flush()
        expect(attempts).toBe(count)
      } else {
        expect(callbacks).toHaveLength(before)
        remote.setForeground(false)
        remote.setForeground(true)
        await flush()
        expect(attempts).toBe(1)
      }
      stop()
    }
  } finally {
    timer.mockRestore()
    random.mockRestore()
  }
})

test.each(['removed', 'replaced', 'lost', 'failed', 'exited'] as const)(
  'foreground reports %s without opening a replacement or restarting the old Terminal Session',
  async (reason) => {
    let opened = 0
    let resumed = false
    const states: string[] = []
    const remote = new RemoteWorkbench({
      async subscribe() {},
      async read(path) {
        const value = await terminalRead(path)
        if (!resumed) return value
        if (path === 'layout/get' && 'runspaces' in value) {
          if (reason === 'removed') return empty
          if (reason === 'replaced') value.runspaces[0]!.tabs[0]!.terminalSessionId = 'replacement'
        }
        if (
          path === 'terminalSession/list' &&
          Array.isArray(value) &&
          ['lost', 'failed', 'exited'].includes(reason)
        ) {
          value[0]!.status = reason
        }
        return value
      },
      async terminal() {
        opened++
        return {
          async prepare() {},
          async input() {},
          async ack() {},
          async close() {
            return true
          },
          next: () => new Promise(() => {}),
        }
      },
    })
    const view = remote.openTerminal(
      { tabId: 'tab', terminalSessionId: 'session' },
      {
        async write() {},
        size() {},
        state(state) {
          states.push(state)
        },
      },
    )
    await flush()
    expect(opened).toBe(1)
    remote.setForeground(false)
    resumed = true
    remote.setForeground(true)
    await flush()
    expect(states.at(-1)).toBe(reason)
    expect(await view.input(new TextEncoder().encode('not-to-old-or-new'))).toBe('not-sent')
    remote.setForeground(false)
    remote.setForeground(true)
    await flush()
    expect(states.at(-1)).toBe(reason)
    expect(opened).toBe(1)
    await view.close()
  },
)

test.each(['closed', 'unavailable'] as const)(
  'terminal %s distinguishes stopped views from transient recovery and requires selection to reopen a stopped view',
  async (cause) => {
    const callbacks: (() => void)[] = []
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const streams: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
    const states: string[] = []
    const signals: AbortSignal[] = []
    const targets: unknown[] = []
    let changed: (() => void) | undefined
    let closes = 0
    const remote = new RemoteWorkbench({
      read: terminalRead,
      async subscribe(change, signal) {
        changed = change
        signals.push(signal)
      },
      async terminal(target) {
        targets.push(target)
        const next = Promise.withResolvers<unknown>()
        streams.push(next)
        const frames: unknown[] = [{ version: 1, type: 'replay_end', sequence: 1 }]
        return {
          async prepare() {},
          async input() {
            throw new Error('stopped or recovering input must not be sent')
          },
          async ack() {},
          async next() {
            return frames.shift() ?? next.promise
          },
          async close() {
            closes++
            return true
          },
        }
      },
    })
    const target = { tabId: 'tab', terminalSessionId: 'session' }
    const display = {
      async write() {},
      size() {},
      state: (state: string) => states.push(state),
    }
    const stop = remote.observe(() => {})
    let view = remote.openTerminal(target, display)
    try {
      await flush()
      expect(states.at(-1)).toBe('viewing')
      if (cause === 'closed') streams[0]!.resolve({ version: 1, type: 'closed' })
      else streams[0]!.reject(new RemoteError('unavailable'))
      await flush()
      expect(states.at(-1)).toBe(cause)
      expect(await view.input(new Uint8Array([65]))).toBe('not-sent')
      if (cause === 'closed') {
        expect(callbacks).toHaveLength(0)
        expect(signals[0]!.aborted).toBe(false)
        changed?.()
        await flush()
        remote.setForeground(false)
        remote.setForeground(true)
        await flush()
        expect(states.at(-1)).toBe('closed')
        expect(streams).toHaveLength(1)
        expect(closes).toBe(1)
        view = remote.openTerminal(target, display)
      } else {
        expect(callbacks).toHaveLength(1)
        expect(signals[0]!.aborted).toBe(true)
        callbacks[0]!()
      }
      await flush()
      expect(states.at(-1)).toBe('viewing')
      expect(targets).toEqual([target, target])
    } finally {
      await view.close()
      stop()
      timer.mockRestore()
    }
  },
)
