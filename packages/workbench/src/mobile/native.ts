import { z } from 'zod'

import { RemoteError, type RemoteTransport } from './remote-workbench.ts'

const FailureSchema = z.enum([
  'unavailable',
  'approval-required',
  'identity-changed',
  'incompatible',
])
const ReplySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), value: z.unknown() }),
  z.object({ state: FailureSchema }),
])
const EventSchema = z.object({
  id: z.string(),
  state: z.union([z.literal('changed'), FailureSchema]),
})

declare global {
  interface Window {
    webkit: { messageHandlers: { monica: { postMessage(message: object): Promise<unknown> } } }
  }
}

export async function nativeCall(operation: string, id?: string): Promise<unknown> {
  const reply = ReplySchema.parse(
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- WKScriptMessageHandlerWithReply is not Window.postMessage.
    await window.webkit.messageHandlers.monica.postMessage({ operation, ...(id && { id }) }),
  )
  if (reply.state !== 'ok') throw new RemoteError(reply.state)
  return reply.value
}

export const nativeTransport: RemoteTransport = {
  async read(procedure, signal) {
    signal.throwIfAborted()
    const id = crypto.randomUUID()
    const cancel = () => {
      void nativeCall('cancel', id).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await nativeCall(procedure, id)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  },
  async subscribe(changed, signal, failed) {
    signal.throwIfAborted()
    const id = crypto.randomUUID()
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const parsed = EventSchema.safeParse(event.detail)
      if (!parsed.success || parsed.data.id !== id || signal.aborted) return
      if (parsed.data.state === 'changed') changed()
      else failed(new RemoteError(parsed.data.state))
    }
    window.addEventListener('monica-change', listener)
    signal.addEventListener(
      'abort',
      () => {
        window.removeEventListener('monica-change', listener)
        void nativeCall('unsubscribe', id).catch(() => {})
      },
      { once: true },
    )
    await nativeCall('subscribe', id)
  },
}

const RegistrationSchema = z.enum(['approved', 'pending', 'rejected', 'expired', 'unregistered'])
export type RegistrationState = z.infer<typeof RegistrationSchema>

export function observeRegistration(
  receive: (state: RegistrationState) => void,
  failed: (error: RemoteError) => void,
): () => void {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  const check = async () => {
    try {
      const result = RegistrationSchema.parse(await nativeCall('registration'))
      if (!active) return
      receive(result)
      attempt = 0
      if (result === 'pending')
        timer = setTimeout(() => {
          void check()
        }, 2000)
    } catch (error) {
      if (!active) return
      const failure = error instanceof RemoteError ? error : new RemoteError('incompatible')
      failed(failure)
      if (failure.state === 'unavailable')
        timer = setTimeout(
          () => {
            void check()
          },
          Math.min(10000, 500 * 2 ** attempt++ * (1 + Math.random() * 0.2)),
        )
    }
  }
  void check()
  return () => {
    active = false
    clearTimeout(timer)
  }
}
