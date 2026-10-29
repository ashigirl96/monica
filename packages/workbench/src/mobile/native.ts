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

const ScanSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('cancelled') }),
  z.object({ state: z.literal('candidate'), expiresAt: z.number().finite().nonnegative() }),
])

export async function scanRegistration(): Promise<'cancelled' | 'expired' | 'ready'> {
  const result = ScanSchema.parse(await nativeCall('scan'))
  if (result.state === 'cancelled') return 'cancelled'
  if (result.expiresAt <= Date.now()) return 'expired'
  if (result.expiresAt > Date.now() + 305_000) throw new RemoteError('incompatible')
  return 'ready'
}

const PendingSchema = z.object({
  state: z.literal('pending'),
  expiresAt: z.number().finite().nonnegative(),
})
const RegistrationMetadataSchema = z.object({
  id: z.string(),
  lifecycle: z.enum(['pending', 'approved', 'unknown']),
  pendingUntil: z.number().finite().nonnegative(),
})
const RegistrationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unregistered') }),
  RegistrationMetadataSchema.extend({ state: z.literal('approved'), version: z.literal(1) }),
  RegistrationMetadataSchema.extend(PendingSchema.shape),
  RegistrationMetadataSchema.extend({
    state: z.literal('rejected'),
    expiresAt: z.number().finite().nonnegative(),
  }),
  RegistrationMetadataSchema.extend({ state: z.literal('unauthorized') }),
])
export type RegistrationState = 'approved' | 'pending' | 'rejected' | 'expired' | 'unregistered'

export async function registerCandidate(): Promise<void> {
  PendingSchema.parse(await nativeCall('register'))
}

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
      if (result.state === 'approved' && result.lifecycle !== 'approved') {
        await nativeCall('registration-approved', result.id)
        if (!active) return
      }
      if (result.state === 'unauthorized') {
        if (result.lifecycle === 'pending' && result.pendingUntil <= Date.now()) receive('expired')
        else throw new RemoteError('approval-required')
      } else receive(result.state)
      attempt = 0
      if (result.state === 'pending')
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
