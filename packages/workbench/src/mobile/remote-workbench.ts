import { ZodError } from 'zod'

import {
  LayoutSchema,
  ListedAgentSessionSchema,
  TerminalSessionSchema,
  type Layout,
  type ListedAgentSession,
  type TerminalSession,
} from '../contract.ts'
import { TerminalFrameSchema } from '../remote-terminal.ts'

export type RemoteUnavailable =
  | 'unavailable'
  | 'approval-required'
  | 'identity-changed'
  | 'incompatible'
export class RemoteError extends Error {
  readonly state: RemoteUnavailable
  constructor(state: RemoteUnavailable) {
    super(state)
    this.state = state
  }
}
export type RemoteState =
  | { state: 'waiting' | RemoteUnavailable }
  | {
      state: 'available'
      layout: Layout
      terminalSessions: TerminalSession[]
      agentSessions: ListedAgentSession[]
    }

export type TerminalTarget = { tabId: string; terminalSessionId: string }
export type TerminalStream = {
  next(): Promise<unknown>
  ack(sequence: number): Promise<void>
  close(): Promise<boolean>
}
export type TerminalDisplay = {
  write(bytes: Uint8Array): Promise<void>
  size(rows: number, cols: number): void
  state(
    state: 'waiting' | 'viewing' | 'exited' | 'closed' | 'detach-pending' | RemoteUnavailable,
  ): void
}
export type TerminalView = { close(): Promise<boolean> }

export type RemoteTransport = {
  terminal(target: TerminalTarget): Promise<TerminalStream>
  read(
    procedure: 'layout/get' | 'terminalSession/list' | 'agentSession/list',
    signal: AbortSignal,
  ): Promise<unknown>
  subscribe(
    changed: () => void,
    signal: AbortSignal,
    failed: (error: RemoteError) => void,
  ): Promise<void>
}

export class RemoteWorkbench {
  private readonly transport: RemoteTransport
  private view: TerminalView | undefined
  constructor(transport: RemoteTransport) {
    this.transport = transport
  }

  openTerminal(target: TerminalTarget, display: TerminalDisplay): TerminalView {
    const previous = this.view
    let active = true
    let stream: TerminalStream | undefined
    let closing: Promise<boolean> | undefined
    let opened: Promise<TerminalStream | undefined>
    const view: TerminalView = {
      close: () => {
        if (closing) return closing
        active = false
        closing = (async () => {
          const connection = stream ?? (await opened.catch(() => undefined))
          const confirmed = connection ? await connection.close().catch(() => false) : true
          display.state(confirmed ? 'closed' : 'detach-pending')
          return confirmed
        })()
        return closing
      },
    }
    this.view = view
    display.state('waiting')
    opened = (async () => {
      if (previous) await previous.close()
      if (!active) return undefined
      return this.transport.terminal(target)
    })()
    void (async () => {
      let next = 1
      let generation = -1
      let exited = false
      try {
        stream = await opened
        if (!active || !stream) return
        for (;;) {
          const frame = TerminalFrameSchema.parse(await stream.next())
          if (!active) return
          if (frame.type === 'closed') {
            if (!exited) display.state('closed')
            return
          }
          if (frame.sequence !== next++) throw new RemoteError('incompatible')
          switch (frame.type) {
            case 'size':
              if (frame.generation > generation) {
                generation = frame.generation
                display.size(frame.rows, frame.cols)
              }
              break
            case 'output':
              await display.write(
                Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0)),
              )
              break
            case 'replay_end':
              display.state('viewing')
              break
            case 'exit':
              exited = true
              display.state('exited')
              break
          }
          if (!active) return
          await stream.ack(frame.sequence)
        }
      } catch (error) {
        if (!active) return
        active = false
        display.state(error instanceof RemoteError ? error.state : 'unavailable')
        if (stream) {
          closing = stream.close().catch(() => false)
          if (!(await closing)) display.state('detach-pending')
        }
      }
    })()
    return view
  }

  observe(receive: (state: RemoteState) => void): () => void {
    const lifetime = new AbortController()
    let connection: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const connect = async () => {
      const current = new AbortController()
      connection = current
      const signal = current.signal
      let dirty = false
      let refreshing = false
      let subscribed = false
      const fail = (error: unknown) => {
        if (signal.aborted || lifetime.signal.aborted) return
        current.abort()
        const state =
          error instanceof RemoteError
            ? error.state
            : error instanceof ZodError
              ? 'incompatible'
              : 'unavailable'
        receive({ state })
        if (state === 'unavailable') {
          const delay = Math.min(10_000, 500 * 2 ** attempt++ * (1 + Math.random() * 0.2))
          timer = setTimeout(() => {
            void connect()
          }, delay)
        }
      }
      const refresh = async () => {
        dirty = true
        if (refreshing || !subscribed) return
        refreshing = true
        try {
          while (dirty && !signal.aborted) {
            dirty = false
            const [layout, terminalSessions, agentSessions] = await Promise.all([
              this.transport.read('layout/get', signal),
              this.transport.read('terminalSession/list', signal),
              this.transport.read('agentSession/list', signal),
            ])
            if (signal.aborted) return
            const snapshot = {
              state: 'available' as const,
              layout: LayoutSchema.parse(layout),
              terminalSessions: TerminalSessionSchema.array().parse(terminalSessions),
              agentSessions: ListedAgentSessionSchema.array().parse(agentSessions),
            }
            if (!dirty) receive(snapshot)
            attempt = 0
          }
        } catch (error) {
          fail(error)
        } finally {
          refreshing = false
        }
      }
      receive({ state: 'waiting' })
      try {
        await this.transport.subscribe(
          () => {
            void refresh()
          },
          signal,
          fail,
        )
        if (signal.aborted) return
        subscribed = true
        await refresh()
      } catch (error) {
        fail(error)
      }
    }
    void connect()
    return () => {
      lifetime.abort()
      connection?.abort()
      clearTimeout(timer)
    }
  }
}
