import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { type EventPublisher, ORPCError } from '@orpc/server'
import type { Server, ServerWebSocket } from 'bun'
import { eq } from 'drizzle-orm'
import createQrCode from 'qrcode-generator'
import { z } from 'zod'

import { listAgentSessions } from './agent-session.ts'
import { RemoteSettingsSchema, type WorkbenchChange } from './contract.ts'
import type { Db } from './db.ts'
import { readLayout } from './layout.ts'
import { listTerminalSessions } from './reads.ts'
import {
  describeIdentity,
  loadIdentity,
  readProtected,
  remoteDirectory,
  writeProtected,
  type RemoteIdentity,
} from './remote-identity.ts'
import { attachShell, type ShellAttachment, type ShellEndpoint } from './remote-shell.ts'
import { remoteSnapshot } from './remote-snapshot.ts'
import { TerminalControlSchema } from './remote-terminal.ts'
import { remoteDevice } from './schema.ts'

const LIFETIME = 5 * 60_000
const WIRE_VERSION = 1
const CredentialSchema = z.string().regex(/^monica-remote-v1\.[0-9a-f]{64}$/)
const RequestSchema = z
  .object({ version: z.literal(WIRE_VERSION), name: z.string().trim().min(1).max(80) })
  .strict()
type Settings = z.infer<typeof RemoteSettingsSchema>
type Pending = {
  id: string
  name: string
  sourceAddress: string
  secretHash: string
  expiresAt: number
  state: 'pending' | 'rejected'
}
type Connection = {
  deviceId: string
  sourceAddress: string
  changes: boolean
  terminal: boolean
  abort: AbortController
  target?: { tabId: string; terminalSessionId: string }
  attachment?: ShellAttachment
  opened?: boolean
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const matches = (value: string, hashed: string) =>
  timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(hashed, 'hex'))

const deny = () =>
  new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } })
const json = (value: object, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export function createRemoteAccess({
  db,
  home,
  changed,
  events,
  unary = (_path, next) => next(),
  shell,
}: {
  db: Db
  home: string
  changed: () => void
  events: EventPublisher<{ change: WorkbenchChange }>
  shell?: ShellEndpoint
  unary?: (path: string[], next: () => Promise<unknown>) => Promise<unknown>
}) {
  let settings: Settings | null = null
  let listener: Server<Connection> | null = null
  let identity: RemoteIdentity | null = null
  let error: string | null = null
  let invitation: { secretHash: string; expiresAt: number } | null = null
  let pending: Pending | null = null
  let stopped = false
  let configurationGeneration = 0
  const hasPending = () => pending?.state === 'pending'
  const sockets = new Set<ServerWebSocket<Connection>>()
  const attachments = new Map<ShellAttachment, string>()
  const detaching = new Set<ShellAttachment>()
  const detachPending = (id?: string) =>
    [...attachments].some(
      ([attachment, device]) =>
        detaching.has(attachment) && !attachment.confirmed && (!id || device === id),
    )
  async function detach(attachment: ShellAttachment) {
    detaching.add(attachment)
    if (await attachment.close()) {
      attachments.delete(attachment)
      detaching.delete(attachment)
    }
    changed()
  }
  let attempts = { start: 0, requests: 0, polls: 0 }

  function expire() {
    if (invitation && invitation.expiresAt <= Date.now()) invitation = null
    if (pending && pending.expiresAt <= Date.now()) pending = null
  }
  function status() {
    expire()
    return {
      state: listener
        ? ('listening' as const)
        : settings
          ? ('unavailable' as const)
          : ('disabled' as const),
      detachPending: detachPending(),
      settings,
      identity: identity ? describeIdentity(identity) : null,
      error,
      invitationExpiresAt: invitation?.expiresAt ?? null,
      pending:
        pending?.state === 'pending'
          ? {
              id: pending.id,
              name: pending.name,
              sourceAddress: pending.sourceAddress,
              expiresAt: pending.expiresAt,
            }
          : null,
      devices: db
        .select({
          id: remoteDevice.id,
          name: remoteDevice.name,
          sourceAddress: remoteDevice.sourceAddress,
          revokedAt: remoteDevice.revokedAt,
        })
        .from(remoteDevice)
        .all()
        .map((device) => ({
          ...device,
          detachPending: device.revokedAt !== null && detachPending(device.id),
        })),
    }
  }
  function authorized(request: Request, sourceAddress: string) {
    if (!listener || stopped) return null
    const credential = CredentialSchema.safeParse(
      request.headers.get('authorization')?.replace(/^Bearer /, ''),
    )
    if (!credential.success) return null
    const device = db
      .select()
      .from(remoteDevice)
      .where(eq(remoteDevice.secretHash, hash(credential.data)))
      .get()
    return device && device.revokedAt === null && device.sourceAddress === sourceAddress
      ? device
      : null
  }
  function rateLimited(poll: boolean) {
    if (Date.now() - attempts.start >= 60_000)
      attempts = { start: Date.now(), requests: 0, polls: 0 }
    return poll ? ++attempts.polls > 120 : ++attempts.requests > 10
  }

  async function fetch(
    request: Request,
    server: Server<Connection>,
  ): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (url.search || request.headers.has('origin')) return deny()
    const sourceAddress = server.requestIP(request)?.address
    if (!sourceAddress || listener !== server || stopped) return deny()
    expire()
    if (url.pathname === '/registration/request' && request.method === 'POST') {
      if (rateLimited(false)) return new Response('Too many requests', { status: 429 })
      const credential = CredentialSchema.safeParse(
        request.headers.get('authorization')?.replace(/^Bearer /, ''),
      )
      const presented = request.headers.get('x-monica-invitation')
      if (
        !credential.success ||
        !presented ||
        !invitation ||
        !matches(presented, invitation.secretHash)
      )
        return deny()
      if (hasPending()) return new Response('A request is already pending', { status: 409 })
      let input: z.infer<typeof RequestSchema>
      try {
        input = RequestSchema.parse(await request.json())
      } catch {
        return new Response('Invalid registration request or wire version', { status: 400 })
      }
      // The body read yields; disable, expiry or another request may have consumed the invitation.
      expire()
      if (listener !== server || !invitation || !matches(presented, invitation.secretHash))
        return deny()
      if (hasPending()) return new Response('A request is already pending', { status: 409 })
      const secretHash = hash(credential.data)
      if (db.select().from(remoteDevice).where(eq(remoteDevice.secretHash, secretHash)).get())
        return deny()
      invitation = null
      pending = {
        ...input,
        id: randomUUID(),
        sourceAddress,
        secretHash,
        expiresAt: Date.now() + LIFETIME,
        state: 'pending',
      }
      changed()
      return json({ id: pending.id, state: 'pending', expiresAt: pending.expiresAt }, 202)
    }
    if (url.pathname === '/registration/status' && request.method === 'POST') {
      if (rateLimited(true)) return new Response('Too many requests', { status: 429 })
      const device = authorized(request, sourceAddress)
      if (device) return json({ id: device.id, state: 'approved', version: WIRE_VERSION })
      const credential = CredentialSchema.safeParse(
        request.headers.get('authorization')?.replace(/^Bearer /, ''),
      )
      if (
        !credential.success ||
        !pending ||
        pending.sourceAddress !== sourceAddress ||
        !matches(credential.data, pending.secretHash)
      )
        return deny()
      return json({ id: pending.id, state: pending.state, expiresAt: pending.expiresAt })
    }
    const device = authorized(request, sourceAddress)
    if (!device) return deny()
    if (url.pathname.startsWith('/workbench/')) {
      if (request.headers.get('x-monica-wire-version') !== String(WIRE_VERSION))
        return json({ version: WIRE_VERSION }, 426)
      if (request.method !== 'GET') return new Response('Not found', { status: 404 })
      const reads = {
        '/workbench/layout/get': () => readLayout(db),
        '/workbench/terminalSession/list': () => listTerminalSessions(db),
        '/workbench/agentSession/list': () => listAgentSessions(db),
      }
      const read = Object.entries(reads).find(([path]) => path === url.pathname)?.[1]
      if (read) {
        const result = await unary(url.pathname.slice(1).split('/'), async () => read())
        if (!authorized(request, sourceAddress)) return deny()
        return remoteSnapshot(result)
      }
      if (
        (url.pathname === '/workbench/changes' || url.pathname === '/workbench/terminal') &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        for (const socket of sockets)
          if (
            socket.data.deviceId === device.id &&
            socket.data.terminal === (url.pathname === '/workbench/terminal')
          ) {
            if (socket.data.attachment) void detach(socket.data.attachment)
            socket.terminate()
          }
        if (
          server.upgrade(request, {
            data: {
              deviceId: device.id,
              sourceAddress,
              terminal: url.pathname === '/workbench/terminal',
              changes: url.pathname === '/workbench/changes',
              abort: new AbortController(),
            },
          })
        )
          return undefined
      }
      return new Response('Not found', { status: 404 })
    }
    if (url.pathname !== '/check' || request.method !== 'GET')
      return new Response('Not found', { status: 404 })
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      for (const socket of sockets) if (socket.data.deviceId === device.id) socket.terminate()
      if (
        server.upgrade(request, {
          data: {
            deviceId: device.id,
            sourceAddress,
            terminal: false,
            changes: false,
            abort: new AbortController(),
          },
        })
      )
        return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }
    return json({ version: WIRE_VERSION, deviceId: device.id })
  }

  function listen(config: Settings) {
    identity = loadIdentity(remoteDirectory(home), config.address)
    listener = Bun.serve<Connection>({
      hostname: config.address,
      port: config.port,
      tls: identity,
      maxRequestBodySize: 64 * 1024,
      idleTimeout: 15,
      fetch,
      websocket: {
        maxPayloadLength: 90_112,
        idleTimeout: 15,
        open(socket) {
          const device = db
            .select()
            .from(remoteDevice)
            .where(eq(remoteDevice.id, socket.data.deviceId))
            .get()
          if (
            !listener ||
            stopped ||
            !device ||
            device.revokedAt !== null ||
            device.sourceAddress !== socket.data.sourceAddress
          ) {
            socket.terminate()
            return
          }
          sockets.add(socket)
          if (socket.data.terminal) return
          if (!socket.data.changes) {
            socket.send(JSON.stringify({ version: WIRE_VERSION, deviceId: device.id }))
            return
          }
          const changes = events.subscribe('change', {
            signal: socket.data.abort.signal,
            maxBufferedEvents: 1,
          })
          socket.send(JSON.stringify({ version: WIRE_VERSION, type: 'subscribed' }))
          void (async () => {
            try {
              for await (const _change of changes) {
                if (socket.data.abort.signal.aborted) break
                if (socket.send(JSON.stringify({ version: WIRE_VERSION, type: 'changed' })) > 0)
                  continue
                socket.terminate()
                break
              }
            } catch {
              socket.terminate()
            }
          })()
        },
        message(socket, message) {
          if (!socket.data.terminal) return socket.close(1008, 'No client messages')
          const device = db
            .select()
            .from(remoteDevice)
            .where(eq(remoteDevice.id, socket.data.deviceId))
            .get()
          if (
            !listener ||
            stopped ||
            !device ||
            device.revokedAt !== null ||
            device.sourceAddress !== socket.data.sourceAddress
          ) {
            socket.terminate()
            return
          }
          try {
            const command = TerminalControlSchema.parse(JSON.parse(String(message)))
            if (command.type === 'close') {
              if (socket.data.attachment) void detach(socket.data.attachment)
              else socket.close()
            } else if (command.type === 'prepare') {
              if (!socket.data.attachment) throw new Error('No attachment')
              socket.data.attachment.prepare()
            } else if (command.type === 'input') {
              const target = socket.data.target
              const current =
                target &&
                readLayout(db)
                  .runspaces.flatMap((r) => r.tabs)
                  .find((t) => t.id === target.tabId)
              const attachment =
                current?.terminalSessionId === target?.terminalSessionId
                  ? socket.data.attachment
                  : undefined
              if (!attachment || !attachment.input(command)) {
                socket.send(
                  JSON.stringify({
                    version: 1,
                    type: 'input_result',
                    id: command.id,
                    result: 'not-sent',
                  }),
                )
              }
            } else if (command.type === 'ack') {
              if (!socket.data.attachment) throw new Error('No attachment')
              socket.data.attachment.ack(command.sequence)
            } else {
              if (
                !shell ||
                socket.data.opened ||
                [...attachments].some(
                  ([attachment, id]) => id === device.id && !attachment.confirmed,
                )
              )
                throw new Error('Shell attachment unavailable')
              socket.data.opened = true
              socket.data.target = command
              const tab = readLayout(db)
                .runspaces.flatMap((runspace) => runspace.tabs)
                .find((item) => item.id === command.tabId)
              if (!tab || tab.terminalSessionId !== command.terminalSessionId)
                throw new Error('Terminal Session changed')
              const attachment = attachShell(
                shell,
                command.terminalSessionId,
                (frame) => {
                  if (socket.data.abort.signal.aborted) return
                  if (
                    socket.send(JSON.stringify(frame)) <= 0 ||
                    socket.getBufferedAmount() > 1_048_576
                  ) {
                    void detach(attachment)
                    socket.terminate()
                  }
                  if (frame.type === 'closed') {
                    attachments.delete(attachment)
                    socket.close()
                  }
                },
                () => {
                  socket.terminate()
                },
              )
              socket.data.attachment = attachment
              attachments.set(attachment, device.id)
              const changes = events.subscribe('change', {
                signal: socket.data.abort.signal,
                maxBufferedEvents: 1,
              })
              void (async () => {
                try {
                  for await (const _change of changes) {
                    const current = readLayout(db)
                      .runspaces.flatMap((runspace) => runspace.tabs)
                      .find((item) => item.id === command.tabId)
                    if (current?.terminalSessionId === command.terminalSessionId) continue
                    if (
                      !current &&
                      !listTerminalSessions(db).some(
                        (session) =>
                          session.id === command.terminalSessionId &&
                          ['starting', 'running'].includes(session.status),
                      )
                    )
                      continue
                    void detach(attachment)
                    socket.terminate()
                    break
                  }
                } catch {
                  socket.terminate()
                }
              })()
            }
          } catch {
            socket.close(1008, 'Invalid terminal message')
          }
        },
        close(socket) {
          socket.data.abort.abort()
          if (socket.data.attachment) void detach(socket.data.attachment)
          sockets.delete(socket)
        },
      },
    })
  }
  function start() {
    try {
      const directory = remoteDirectory(home)
      const saved = readProtected(join(directory, 'settings.json'))
      if (saved === null) return
      settings = RemoteSettingsSchema.parse(JSON.parse(saved))
      listen(settings)
    } catch {
      error =
        'Remote TLS could not start. Check the Tailscale address, port and protected identity; there is no fallback.'
      changed()
    }
  }
  async function disconnect(deviceId?: string) {
    const previous = deviceId ? null : listener
    if (!deviceId) listener = null
    for (const socket of sockets) {
      if (!deviceId || socket.data.deviceId === deviceId) {
        socket.data.abort.abort()
        socket.terminate()
        sockets.delete(socket)
      }
    }
    const stopping = previous?.stop(true)
    await Promise.all(
      [...attachments]
        .filter(([, id]) => !deviceId || deviceId === id)
        .map(([attachment]) => detach(attachment)),
    )
    if (!deviceId) {
      await stopping
    }
  }
  function stop() {
    stopped = true
    invitation = null
    pending = null
    void disconnect()
  }
  async function disable() {
    configurationGeneration++
    settings = null
    invitation = null
    pending = null
    error = null
    const disconnecting = disconnect()
    try {
      rmSync(join(remoteDirectory(home), 'settings.json'), { force: true })
    } finally {
      changed()
      await disconnecting
    }
    return { state: detachPending() ? ('detach-pending' as const) : ('detached' as const) }
  }
  async function enable(input: Settings) {
    const config = RemoteSettingsSchema.parse(input)
    const disabling = disable()
    const generation = configurationGeneration
    await disabling
    if (stopped || generation !== configurationGeneration) throw new ORPCError('CONFLICT')
    settings = config
    try {
      listen(config)
      writeProtected(join(remoteDirectory(home), 'settings.json'), JSON.stringify(config))
    } catch {
      await disconnect()
      error =
        'Remote TLS could not start. Check the Tailscale address, port and protected identity; there is no fallback.'
    }
    changed()
  }
  function invite() {
    expire()
    if (!listener || !settings || !identity)
      throw new ORPCError('CONFLICT', { message: 'Remote TLS is not listening' })
    if (pending?.state === 'pending')
      throw new ORPCError('CONFLICT', { message: 'Approve or reject the pending request first' })
    const secret = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + LIFETIME
    const host = settings.address.includes(':') ? `[${settings.address}]` : settings.address
    const payload = JSON.stringify({
      version: WIRE_VERSION,
      endpoint: `https://${host}:${settings.port}`,
      ...describeIdentity(identity),
      invitation: secret,
      expiresAt,
    })
    const code = createQrCode(0, 'M')
    code.addData(payload, 'Byte')
    code.make()
    const qr = code.createDataURL(4, 16)
    invitation = { secretHash: hash(secret), expiresAt }
    changed()
    return { payload, qr, expiresAt }
  }
  function decide(id: string, approve: boolean) {
    expire()
    if (!listener || pending?.id !== id || pending.state !== 'pending')
      throw new ORPCError('NOT_FOUND')
    if (approve) {
      db.insert(remoteDevice)
        .values({
          id: pending.id,
          name: pending.name,
          secretHash: pending.secretHash,
          sourceAddress: pending.sourceAddress,
          revokedAt: null,
        })
        .run()
      pending = null
    } else pending.state = 'rejected'
    changed()
  }
  async function revoke(id: string) {
    db.update(remoteDevice).set({ revokedAt: new Date() }).where(eq(remoteDevice.id, id)).run()
    changed()
    await disconnect(id)
    return { state: detachPending(id) ? ('detach-pending' as const) : ('detached' as const) }
  }
  async function renewIdentity() {
    const disabling = disable()
    const generation = configurationGeneration
    await disabling
    if (stopped || generation !== configurationGeneration) throw new ORPCError('CONFLICT')
    db.update(remoteDevice).set({ revokedAt: new Date() }).run()
    rmSync(join(remoteDirectory(home), 'identity.json'), { force: true })
    identity = null
    changed()
  }
  return {
    start,
    stop,
    status,
    enable,
    disable,
    invite,
    approve: (id: string) => decide(id, true),
    reject: (id: string) => decide(id, false),
    revoke,
    renewIdentity,
  }
}

export type RemoteAccess = ReturnType<typeof createRemoteAccess>
