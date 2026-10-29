import {
  LayoutSchema,
  ListedAgentSessionSchema,
  TerminalSessionSchema,
  type Layout,
  type ListedAgentSession,
  type TerminalSession,
} from '../contract.ts'

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

export type RemoteTransport = {
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
  constructor(transport: RemoteTransport) {
    this.transport = transport
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
        const state = error instanceof RemoteError ? error.state : 'unavailable'
        receive({ state })
        if (state === 'unavailable') {
          const delay = Math.min(10_000, 500 * 2 ** attempt++) * (0.8 + Math.random() * 0.2)
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
