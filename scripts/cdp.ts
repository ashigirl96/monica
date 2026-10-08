import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Cdp = {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  close(): void
}

type Reply = { id?: number; result?: unknown; error?: { message: string } }

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
  let lastId = 0
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`CDP に繋がらない: ${url}`)))
  })
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(String(event.data)) as Reply
    const waiter = reply.id === undefined ? undefined : pending.get(reply.id)
    if (!waiter || reply.id === undefined) return
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('CDP の接続が切れた'))
    pending.clear()
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
