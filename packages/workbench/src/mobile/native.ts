import { z } from 'zod'

import { RemoteError, type RemoteTransport } from './remote-workbench.ts'

const FailureSchema = z.enum([
  'unavailable',
  'approval-required',
  'revoked',
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

export async function nativeCall(
  operation: string,
  id?: string,
  fields: Record<string, string> = {},
): Promise<unknown> {
  const reply = ReplySchema.parse(
    /* oxlint-disable unicorn/require-post-message-target-origin -- WKScriptMessageHandlerWithReply is not Window.postMessage. */
    await window.webkit.messageHandlers.monica.postMessage({
      operation,
      ...(id && { id }),
      ...fields,
    }),
    /* oxlint-enable unicorn/require-post-message-target-origin */
  )
  if (reply.state !== 'ok') throw new RemoteError(reply.state)
  return reply.value
}

export const nativeTransport: RemoteTransport = {
  async terminal(target) {
    const id = crypto.randomUUID()
    await nativeCall('terminal-open', id, target)
    return {
      async prepare() {
        await nativeCall('terminal-prepare', id)
      },
      async input(command) {
        await nativeCall('terminal-input', id, {
          data: command.data,
          sequence: String(command.id),
          renderer: String(command.generation.renderer),
          connection: String(command.generation.connection),
        })
      },
      next: () => nativeCall('terminal-next', id),
      async ack(sequence) {
        await nativeCall('terminal-ack', id, { sequence: String(sequence) })
      },
      async close() {
        return z.boolean().parse(await nativeCall('terminal-close', id))
      },
    }
  },
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
    if (!active) return
    try {
      const result = RegistrationSchema.parse(await nativeCall('registration'))
      if (!active) return
      if (result.state === 'approved' && result.lifecycle !== 'approved') {
        await nativeCall('registration-approved', result.id)
        if (!active) return
      }
      if (result.state === 'unauthorized') {
        if (result.lifecycle === 'pending' && result.pendingUntil <= Date.now()) receive('expired')
        else
          throw new RemoteError(result.lifecycle === 'approved' ? 'revoked' : 'approval-required')
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
          Math.min(10000 / 1.2, 500 * 2 ** Math.min(attempt++, 5)) * (1 + Math.random() * 0.2),
        )
    }
  }
  void check()
  return () => {
    active = false
    clearTimeout(timer)
  }
}

export async function readClipboardText(): Promise<string> {
  return z.string().parse(await nativeCall('clipboard-read'))
}

export async function writeClipboardText(text: string): Promise<void> {
  await nativeCall('clipboard-write', undefined, { text })
}

export function observeForeground(receive: (foreground: boolean) => void): () => void {
  let active = true
  let notified = false
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'boolean') return
    notified = true
    receive(event.detail)
  }
  window.addEventListener('monica-foreground', listener)
  void nativeCall('foreground')
    .then((value) => {
      if (active && !notified) receive(z.boolean().parse(value))
    })
    .catch(() => {
      if (active && !notified) receive(false)
    })
  return () => {
    active = false
    window.removeEventListener('monica-foreground', listener)
  }
}
