import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Cdp = {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  /** CDP の event を受ける。flatten の session の event は sessionId 付きで届く。 */
  on(method: string, listener: (params: unknown, sessionId?: string) => void): void
  /** 接続が切れたら resolve する。Brave が止まったときも。 */
  closed: Promise<void>
  close(): void
}

type Reply = {
  id?: number
  result?: unknown
  error?: { message: string }
  method?: string
  params?: unknown
  sessionId?: string
}

// Chromium は --remote-debugging-port=0 で選んだ port と browser の path を user-data-dir の DevToolsActivePort に書く。
export function browserEndpoint(userDataDir: string): string | undefined {
  try {
    const [port, path] = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')
    return port && path ? `ws://127.0.0.1:${port}${path}` : undefined
  } catch {
    return undefined
  }
}

export async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url)
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const listeners = new Map<string, ((params: unknown, sessionId?: string) => void)[]>()
  let lastId = 0
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`CDP に繋がらない: ${url}`)))
  })
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(String(event.data)) as Reply
    if (reply.method !== undefined) {
      for (const listener of listeners.get(reply.method) ?? [])
        listener(reply.params, reply.sessionId)
      return
    }
    const waiter = reply.id === undefined ? undefined : pending.get(reply.id)
    if (!waiter || reply.id === undefined) return
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  })
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>()
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('CDP の接続が切れた'))
    pending.clear()
    markClosed()
  })
  return {
    send<T>(method: string, params: object = {}, sessionId?: string) {
      const id = ++lastId
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject: (error) => reject(new Error(`${method}: ${error.message}`)),
        })
      })
    },
    on(method: string, listener: (params: unknown, sessionId?: string) => void) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    },
    closed,
    close: () => socket.close(),
  }
}

type Evaluated = {
  result: { value?: unknown; description?: string }
  exceptionDetails?: { exception?: { description?: string }; text: string }
}

// 例外は値として返さず throw する。
export async function evaluate(
  cdp: Cdp,
  sessionId: string,
  expression: string,
  options: { userGesture?: boolean } = {},
): Promise<unknown> {
  const { result, exceptionDetails } = await cdp.send<Evaluated>(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, ...options },
    sessionId,
  )
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  }
  return result.value
}

export async function attach(cdp: Cdp, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  return sessionId
}
