import { ZodError } from 'zod'

import {
  LayoutSchema,
  ListedAgentSessionSchema,
  TerminalSessionSchema,
  type Layout,
  type ListedAgentSession,
  type TerminalSession,
} from '../contract.ts'
import {
  TerminalFrameSchema,
  type RendererGeneration,
  type TerminalInput,
  type InputResult,
} from '../remote-terminal.ts'

export type RemoteUnavailable =
  | 'unavailable'
  | 'approval-required'
  | 'revoked'
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
  | { state: 'waiting' | 'background' | RemoteUnavailable }
  | {
      state: 'available'
      layout: Layout
      terminalSessions: TerminalSession[]
      agentSessions: ListedAgentSession[]
    }

export type TerminalTarget = { tabId: string; terminalSessionId: string }
export type TerminalStream = {
  prepare(): Promise<void>
  input(command: TerminalInput): Promise<void>
  next(): Promise<unknown>
  ack(sequence: number): Promise<void>
  close(): Promise<boolean>
}
export type TerminalDisplay = {
  reset?(): void
  write(bytes: Uint8Array): Promise<void>
  size(rows: number, cols: number): void
  inputReady?(ready: boolean): void
  state(
    state:
      | 'waiting'
      | 'background'
      | 'viewing'
      | 'removed'
      | 'replaced'
      | 'lost'
      | 'failed'
      | 'exited'
      | 'closed'
      | 'detach-pending'
      | RemoteUnavailable,
  ): void
}
export type TerminalView = {
  input(bytes: Uint8Array): Promise<InputResult>
  close(): Promise<boolean>
}

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
  private readonly observers = new Set<(state: RemoteState) => void>()
  private state: RemoteState = { state: 'waiting' }
  private foreground = true
  private stopConnection: (() => void) | undefined
  private failConnection: ((error: unknown) => void) | undefined
  private blocked = false
  private connectionReady: (() => void) | undefined
  constructor(transport: RemoteTransport) {
    this.transport = transport
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return
    this.foreground = foreground
    this.stopConnection?.()
    this.stopConnection = undefined
    this.failConnection = undefined
    if (!foreground && !this.blocked) this.publish({ state: 'background' })
    else if (this.observers.size && !this.blocked) this.startConnection()
  }

  private publish(state: RemoteState): void {
    this.state = state
    for (const receive of this.observers) receive(state)
  }

  private startConnection(): void {
    this.stopConnection = this.connect((state) => this.publish(state))
  }

  observe(receive: (state: RemoteState) => void): () => void {
    this.observers.add(receive)
    if (this.observers.size === 1 && this.foreground) this.startConnection()
    else receive(this.state)
    return () => {
      this.observers.delete(receive)
      if (this.observers.size) return
      this.stopConnection?.()
      this.stopConnection = undefined
      this.failConnection = undefined
      this.blocked = false
      this.state = { state: this.foreground ? 'waiting' : 'background' }
    }
  }

  openTerminal(target: TerminalTarget, display: TerminalDisplay): TerminalView {
    const previous = this.view
    let attachment: TerminalView | undefined
    let released = previous?.close() ?? Promise.resolve(true)
    let generation = 0
    let active = true
    let ended: 'removed' | 'replaced' | 'lost' | 'failed' | 'exited' | undefined
    let uncertain = false
    const release = () => {
      generation++
      display.inputReady?.(false)
      if (attachment) {
        released = attachment.close()
        attachment = undefined
      }
      return released
    }
    const stop = this.observe((snapshot) => {
      if (!active) return
      if (snapshot.state !== 'available') {
        void release()
        display.state(snapshot.state)
        return
      }
      if (ended) {
        display.state(ended)
        return
      }
      const tab = snapshot.layout.runspaces
        .flatMap((runspace) => runspace.tabs)
        .find((item) => item.id === target.tabId)
      const session = snapshot.terminalSessions.find((item) => item.id === target.terminalSessionId)
      const invalid =
        tab && tab.terminalSessionId !== target.terminalSessionId
          ? 'replaced'
          : session?.status === 'exited'
            ? 'exited'
            : !tab
              ? 'removed'
              : !session
                ? 'lost'
                : session.status === 'running' || session.status === 'starting'
                  ? undefined
                  : session.status
      // Final output and Exit may still be behind a draw ACK when the Tab leaves the list.
      if ((invalid === 'exited' || invalid === 'removed') && attachment) {
        ended = invalid
        display.inputReady?.(false)
        if (invalid === 'removed') display.state('removed')
        return
      }
      if (invalid) {
        ended = invalid
        void release()
        display.state(invalid)
        return
      }
      if (attachment) return
      if (session?.status === 'starting') {
        display.state('waiting')
        return
      }
      const current = ++generation
      void (async () => {
        await released
        if (!active || ended || current !== generation) return
        display.reset?.()
        attachment = this.attachTerminal(target, {
          write: (bytes) => display.write(bytes),
          size: (rows, cols) => {
            if (current === generation) display.size(rows, cols)
          },
          inputReady: (ready) => {
            if (current === generation) display.inputReady?.(ready && !uncertain && !ended)
          },
          state: (state) => {
            if (!active || current !== generation) return
            if (state === 'viewing') this.connectionReady?.()
            if (state === 'exited') ended = 'exited'
            if (ended) {
              if (state === 'exited') display.state(ended)
              return
            }
            if (state === 'unavailable' || state === 'closed') {
              this.failConnection?.(new RemoteError('unavailable'))
            } else if (
              state === 'identity-changed' ||
              state === 'incompatible' ||
              state === 'approval-required' ||
              state === 'revoked'
            ) {
              this.failConnection?.(new RemoteError(state))
            } else display.state(state)
          },
        })
      })()
    })
    const view: TerminalView = {
      input: async (bytes) => {
        if (!active || uncertain || ended || !attachment) return 'not-sent'
        const result = await attachment.input(bytes)
        if (result === 'uncertain') {
          uncertain = true
          if (active) display.inputReady?.(false)
        }
        return result
      },
      close: () => {
        if (!active) return released
        active = false
        if (this.view === view) this.view = undefined
        stop()
        const closing = release()
        return closing.then((confirmed) => {
          display.state(confirmed ? 'closed' : 'detach-pending')
          return confirmed
        })
      },
    }
    this.view = view
    return view
  }

  private attachTerminal(target: TerminalTarget, display: TerminalDisplay): TerminalView {
    let active = true
    let stream: TerminalStream | undefined
    let closing: Promise<boolean> | undefined
    let opened: Promise<TerminalStream | undefined>
    let renderer: RendererGeneration | undefined
    let replayed = false
    let uncertain = false
    let inputId = 0
    let pending: { id: number; resolve: (result: InputResult) => void } | undefined
    const finishInput = (result: InputResult, id = pending?.id) => {
      if (!pending || pending.id !== id) return
      pending.resolve(result)
      pending = undefined
      if (result === 'uncertain') {
        uncertain = true
        display.inputReady?.(false)
      }
    }
    const view: TerminalView = {
      input: async (bytes) => {
        if (
          !active ||
          !stream ||
          !replayed ||
          !renderer ||
          uncertain ||
          pending ||
          bytes.length > 65536 ||
          bytes.length === 0
        )
          return 'not-sent'
        const result = Promise.withResolvers<InputResult>()
        const id = ++inputId
        pending = { id, resolve: result.resolve }
        const timer = setTimeout(() => finishInput('uncertain', id), 6000)
        try {
          let data = ''
          for (const byte of bytes) data += String.fromCharCode(byte)
          void stream
            .input({ type: 'input', id, data: btoa(data), generation: renderer })
            .catch(() => finishInput('uncertain', id))
        } catch {
          finishInput('uncertain', id)
        }
        return result.promise.finally(() => clearTimeout(timer))
      },
      close: () => {
        if (closing) return closing
        active = false
        display.inputReady?.(false)
        finishInput('uncertain')
        closing = (async () => {
          const connection = stream ?? (await opened.catch(() => undefined))
          const confirmed = connection ? await connection.close().catch(() => false) : true
          display.state(confirmed ? 'closed' : 'detach-pending')
          return confirmed
        })()
        return closing
      },
    }
    display.state('waiting')
    opened = (async () => {
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
        await stream.prepare()
        for (;;) {
          const frame = TerminalFrameSchema.parse(await stream.next())
          if (!active) return
          if (frame.type === 'input_result') {
            if (frame.id === pending?.id) finishInput(frame.result)
            continue
          }
          if (frame.type === 'renderer') {
            renderer = frame.generation ?? undefined
            display.inputReady?.(!!renderer && replayed && !uncertain)
            continue
          }
          if (frame.type === 'closed') {
            active = false
            display.inputReady?.(false)
            finishInput('uncertain')
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
              replayed = true
              display.inputReady?.(!!renderer && !uncertain)
              display.state('viewing')
              break
            case 'exit':
              exited = true
              replayed = false
              display.inputReady?.(false)
              display.state('exited')
              break
          }
          if (!active) return
          await stream.ack(frame.sequence)
        }
      } catch (error) {
        if (!active) return
        active = false
        finishInput('uncertain')
        display.inputReady?.(false)
        if (stream) closing = stream.close().catch(() => false)
        display.state(
          error instanceof RemoteError
            ? error.state
            : error instanceof ZodError
              ? 'incompatible'
              : 'unavailable',
        )
        if (closing && !(await closing)) display.state('detach-pending')
      }
    })()
    return view
  }

  private connect(receive: (state: RemoteState) => void): () => void {
    const lifetime = new AbortController()
    let connection: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    this.connectionReady = () => {
      attempt = 0
    }
    const connect = async () => {
      if (lifetime.signal.aborted) return
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
        this.blocked = state !== 'unavailable'
        receive({ state })
        if (state === 'unavailable') {
          const delay =
            Math.min(10_000 / 1.2, 500 * 2 ** Math.min(attempt++, 5)) * (1 + Math.random() * 0.2)
          timer = setTimeout(() => {
            void connect()
          }, delay)
        }
      }
      this.failConnection = fail
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
            if (!this.view) attempt = 0
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
