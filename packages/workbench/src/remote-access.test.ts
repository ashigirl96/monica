import { afterEach, expect, setDefaultTimeout, spyOn, test, setSystemTime } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, statSync } from 'node:fs'
import https from 'node:https'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { checkServerIdentity } from 'node:tls'

import {
  RemoteWorkbench,
  type TerminalStream,
  type RemoteState,
} from './mobile/remote-workbench.ts'
import { TerminalFrameSchema } from './remote-terminal.ts'
import { remoteDevice } from './schema.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

setDefaultTimeout(30_000)
const stopShells: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stopShells.splice(0)) await stop()
  setSystemTime()
  cleanUp()
})
// Synthetic test address; the bind fixture redirects traffic to isolated loopback.
const syntheticTailnetAddress = [100, 64, 0, 1].join('.')
const secret = () => `monica-remote-v1.${randomBytes(32).toString('hex')}`

async function listening(shell?: import('./remote-shell.ts').ShellEndpoint) {
  const fixture = setup({ shell })
  const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = free.port!
  await free.stop(true)
  const serve = Bun.serve
  let remoteServer: Pick<ReturnType<typeof Bun.serve>, 'stop'> | undefined
  const bind = spyOn(Bun, 'serve').mockImplementation((options) => {
    Object.assign(options, { hostname: '127.0.0.1' })
    const started = serve(options)
    remoteServer = started
    return started
  })
  try {
    await fixture.client.remote.enable({ address: syntheticTailnetAddress, port })
  } finally {
    bind.mockRestore()
  }
  expect((await fixture.client.remote.status()).state).toBe('listening')
  const identity = JSON.parse(
    readFileSync(join(fixture.home, 'remote', 'identity.json'), 'utf8'),
  ) as { cert: string; key: string }
  const options = {
    hostname: '127.0.0.1',
    port,
    ca: identity.cert,
    checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
      checkServerIdentity(syntheticTailnetAddress, cert),
  }
  function request(
    path: string,
    credential?: string,
    invitation?: string,
    body?: object,
    extra: Record<string, string> = {},
    localAddress?: string,
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          ...options,
          localAddress,
          path,
          method: body ? 'POST' : 'GET',
          headers: {
            ...(credential && { authorization: `Bearer ${credential}` }),
            ...(invitation && { 'x-monica-invitation': invitation }),
            'content-type': 'application/json',
            ...extra,
          },
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (data) => {
            text += data
          })
          res.on('end', () => {
            if (res.headers['content-type'] === 'application/x-ndjson') {
              const frames = text
                .trimEnd()
                .split('\n')
                .map((line) => JSON.parse(line))
              expect(frames.at(-1)).toEqual({ version: 1, type: 'end', count: frames.length - 1 })
              const parts = frames.slice(0, -1).map((frame, index) => {
                expect(frame.index).toBe(index)
                expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(65536)
                return Buffer.from(frame.data, 'base64')
              })
              text = Buffer.concat(parts).toString('utf8')
            }
            resolve({ status: res.statusCode!, body: text })
          })
        },
      )
      req.on('error', reject)
      req.end(body && JSON.stringify(body))
    })
  }
  async function invite() {
    const result = await fixture.client.remote.invite()
    const payload = JSON.parse(result.payload) as {
      invitation: string
      certificate: string
      endpoint: string
      expiresAt: number
    }
    return { ...result, ...payload }
  }
  const register = (credential: string, invitation: string, extra?: Record<string, string>) =>
    request(
      '/registration/request',
      credential,
      invitation,
      { version: 1, name: 'My iPhone' },
      extra,
    )
  const poll = (credential: string) => request('/registration/status', credential, undefined, {})
  async function approved() {
    const invitation = await invite()
    const credential = secret()
    const response = await register(credential, invitation.invitation)
    expect(response.status).toBe(202)
    const id = (JSON.parse(response.body) as { id: string }).id
    await fixture.client.remote.approve({ id })
    return { credential, id }
  }
  async function websocket(credential: string, path = '/check') {
    return new Promise<{ socket: Duplex; closed: Promise<void>; greeting: Promise<Buffer> }>(
      (resolve, reject) => {
        const req = https.request({
          ...options,
          path,
          headers: {
            authorization: `Bearer ${credential}`,
            'x-monica-wire-version': '1',
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': randomBytes(16).toString('base64'),
          },
        })
        req.on('upgrade', (_res, socket, head) => {
          onCleanup(() => socket.destroy())
          const closed = new Promise<void>((finish) => socket.once('close', () => finish()))
          const greeting = head.length
            ? Promise.resolve(head)
            : new Promise<Buffer>((greeted) => socket.once('data', greeted))
          resolve({ socket, closed, greeting })
        })
        req.on('response', (res) => {
          res.resume()
          reject(new Error(`upgrade refused: ${res.statusCode}`))
        })
        req.on('error', reject)
        req.end()
      },
    )
  }
  return {
    ...fixture,
    remoteServer: remoteServer!,
    port,
    identity,
    options,
    request,
    invite,
    register,
    poll,
    approved,
    websocket,
  }
}

test('a one-use invitation needs Mac approval, polling proves possession and approval never reissues a secret', async () => {
  const f = await listening()
  const invite = await f.invite()
  const credential = secret()
  expect(invite.invitation).toMatch(/^[0-9a-f]{64}$/)
  expect(invite.expiresAt - Date.now()).toBeGreaterThan(290_000)
  expect(invite.endpoint).toBe(`https://${syntheticTailnetAddress}:${f.port}`)
  expect(invite.qr.startsWith('data:image/gif;base64,R0lGOD')).toBe(true)
  expect((await f.request('/check', credential)).status).toBe(401)
  expect((await f.register(credential, invite.invitation)).status).toBe(202)
  const pending = (await f.client.remote.status()).pending!
  expect(pending).toMatchObject({ name: 'My iPhone', sourceAddress: '127.0.0.1' })
  expect((await f.register(secret(), invite.invitation)).status).toBe(401)
  expect((await f.poll(secret())).status).toBe(401)
  expect(JSON.parse((await f.poll(credential)).body)).toMatchObject({
    state: 'pending',
    id: pending.id,
  })
  expect((await f.request('/check', credential)).status).toBe(401)
  await expect(f.client.remote.invite()).rejects.toThrow()
  await f.client.remote.approve({ id: pending.id })
  for (let i = 0; i < 2; i++)
    expect(JSON.parse((await f.poll(credential)).body)).toEqual({
      id: pending.id,
      state: 'approved',
      version: 1,
    })
  expect(JSON.parse((await f.request('/check', credential)).body)).toEqual({
    deviceId: pending.id,
    version: 1,
  })
  const row = f.db.select().from(remoteDevice).get()!
  expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/)
  expect(row.secretHash).not.toContain(credential.slice('monica-remote-v1.'.length))
  expect(JSON.stringify(await f.client.remote.status())).not.toContain(row.secretHash)
})

test('registration expires after five minutes, rejection stays denied and attempts are rate limited', async () => {
  const f = await listening()
  const invite = await f.invite()
  setSystemTime(invite.expiresAt)
  expect((await f.register(secret(), invite.invitation)).status).toBe(401)
  setSystemTime()
  const next = await f.invite()
  const credential = secret()
  await f.register(credential, next.invitation)
  const pending = (await f.client.remote.status()).pending!
  setSystemTime(pending.expiresAt)
  expect((await f.poll(credential)).status).toBe(401)
  await expect(f.client.remote.approve({ id: pending.id })).rejects.toThrow()
  setSystemTime()
  const last = await f.invite()
  const rejected = secret()
  await f.register(rejected, last.invitation)
  await f.client.remote.reject({ id: (await f.client.remote.status()).pending!.id })
  expect(JSON.parse((await f.poll(rejected)).body).state).toBe('rejected')
  expect((await f.request('/check', rejected)).status).toBe(401)
  let response = await f.register(secret(), 'wrong')
  for (let i = 0; i < 11; i++) response = await f.register(secret(), 'wrong')
  expect(response.status).toBe(429)
})

test('the real TLS boundary rejects wrong credentials, URLs, forwarded identity, extra procedures and oversized bodies', async () => {
  const f = await listening()
  const { credential } = await f.approved()
  for (const token of [undefined, randomBytes(32).toString('hex'), secret()])
    expect((await f.request('/check', token)).status).toBe(401)
  expect((await f.request(`/check?token=${credential}`, credential)).status).toBe(401)
  expect(
    (
      await f.request('/check', credential, undefined, undefined, {
        origin: 'https://evil.example',
      })
    ).status,
  ).toBe(401)
  expect((await f.request('/rpc/workbench/layout/get', credential, undefined, {})).status).toBe(404)
  expect((await f.request('/rpc/workbench/remote/approve', credential, undefined, {})).status).toBe(
    404,
  )
  expect(
    (await f.request('/registration/request', secret(), 'wrong', { text: 'x'.repeat(65536) }))
      .status,
  ).toBe(413)
  const row = f.db.select().from(remoteDevice).get()!
  expect(row.sourceAddress).toBe('127.0.0.1')
  f.db.update(remoteDevice).set({ sourceAddress: '192.0.2.2' }).run()
  expect(
    (
      await f.request('/check', credential, undefined, undefined, {
        'x-forwarded-for': '192.0.2.2',
        forwarded: 'for=192.0.2.2',
      })
    ).status,
  ).toBe(401)
})

test('revocation and disable close real WSS connections before returning, and refuse the credential afterwards', async () => {
  const f = await listening()
  const first = await f.approved()
  const ws = await f.websocket(first.credential)
  expect((await ws.greeting).toString()).toContain(first.id)
  await f.client.remote.revoke({ id: first.id })
  expect(
    await Promise.race([ws.closed.then(() => 'closed'), Bun.sleep(200).then(() => 'open')]),
  ).toBe('closed')
  expect((await f.request('/check', first.credential)).status).toBe(401)
  await expect(f.websocket(first.credential)).rejects.toThrow('401')
  const second = await f.approved()
  const active = await f.websocket(second.credential)
  await active.greeting
  await f.client.remote.disable()
  expect(
    await Promise.race([active.closed.then(() => 'closed'), Bun.sleep(200).then(() => 'open')]),
  ).toBe('closed')
  await expect(f.request('/check', second.credential)).rejects.toThrow()
  expect((await f.client.remote.status()).state).toBe('disabled')
})

test('TLS verification uses a trust anchor and hostname, identity files are protected and renewal revokes devices', async () => {
  const f = await listening()
  const { credential } = await f.approved()
  const get = (options: https.RequestOptions) =>
    new Promise<void>((resolve, reject) => {
      const req = https.get({ ...f.options, ...options, path: '/check' }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', reject)
    })
  await expect(get({ ca: undefined })).rejects.toThrow()
  await expect(
    get({ checkServerIdentity: (_host, cert) => checkServerIdentity('wrong.example', cert) }),
  ).rejects.toThrow()
  expect(statSync(join(f.home, 'remote')).mode & 0o777).toBe(0o700)
  expect(statSync(join(f.home, 'remote', 'identity.json')).mode & 0o777).toBe(0o600)
  expect(statSync(join(f.home, 'remote', 'settings.json')).mode & 0o777).toBe(0o600)
  await f.client.remote.renewIdentity()
  expect(
    (await f.client.remote.status()).devices.every((device) => device.revokedAt !== null),
  ).toBe(true)
  expect((await f.client.remote.status()).identity).toBeNull()
  expect(credential).not.toBe(f.identity.key)
})

test.skipIf(process.platform !== 'darwin')(
  'the registration QR decodes to the exact invitation and pinned identity shown by the management procedure',
  async () => {
    const f = await listening()
    const invite = await f.invite()
    const decoded = Bun.spawnSync(
      [
        '/usr/bin/swift',
        '-e',
        `import Foundation
import CoreImage
let image = CIImage(data: FileHandle.standardInput.readDataToEndOfFile())!
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let codes = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
FileHandle.standardOutput.write(codes.first!.data(using: .utf8)!)
`,
      ],
      {
        env: { ...process.env, TMPDIR: f.home },
        stdin: Buffer.from(invite.qr.slice('data:image/gif;base64,'.length), 'base64'),
        timeout: 20_000,
      },
    )
    expect(decoded.success).toBe(true)
    expect(decoded.stdout.toString()).toBe(invite.payload)
  },
)

test('overlapping configuration operations cannot reopen a listener after a later disable', async () => {
  const f = await listening()
  const originalStop = f.remoteServer.stop.bind(f.remoteServer)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stop = spyOn(f.remoteServer, 'stop').mockImplementation(async (force) => {
    entered.resolve()
    await release.promise
    await originalStop(force)
  })
  onCleanup(() => {
    release.resolve()
    stop.mockRestore()
  })
  const enabling = f.client.remote.enable({ address: syntheticTailnetAddress, port: f.port })
  const outcome = enabling.then(
    () => 'enabled',
    () => 'superseded',
  )
  await entered.promise
  await f.client.remote.disable()
  release.resolve()
  expect(await outcome).toBe('superseded')
  expect((await f.client.remote.status()).state).toBe('disabled')
  await expect(f.request('/check', secret())).rejects.toThrow()
})

test('concurrent registration consumes an invitation exactly once and incompatible versions cannot consume it', async () => {
  const f = await listening()
  const invite = await f.invite()
  expect(
    (
      await f.request('/registration/request', secret(), invite.invitation, {
        version: 2,
        name: 'Wrong version',
      })
    ).status,
  ).toBe(400)
  const credentials = [secret(), secret()]
  const requests = await Promise.all(
    credentials.map((credential) => f.register(credential, invite.invitation)),
  )
  expect(requests.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([202, 401])
  expect((await f.client.remote.status()).pending).not.toBeNull()
  expect(f.db.select().from(remoteDevice).all()).toHaveLength(0)
})

test('restart discards an unconsumed invitation while retaining the TLS identity, and expired identities require explicit renewal', async () => {
  const f = await listening()
  const invite = await f.invite()
  const restarted = f.restartBackend()
  const serve = Bun.serve
  const bind = spyOn(Bun, 'serve').mockImplementation((options) => {
    Object.assign(options, { hostname: '127.0.0.1' })
    return serve(options)
  })
  try {
    await restarted.workbenchLedger.start()
  } finally {
    bind.mockRestore()
  }
  expect((await restarted.client.remote.status()).identity?.fingerprint).toBe(
    (await f.client.remote.status()).identity?.fingerprint,
  )
  expect((await f.register(secret(), invite.invitation)).status).toBe(401)
  const saved = readFileSync(join(f.home, 'remote', 'identity.json'), 'utf8')
  const { X509Certificate } = await import('node:crypto')
  setSystemTime(Date.parse(new X509Certificate(f.identity.cert).validTo) + 1)
  await restarted.client.remote.enable({ address: syntheticTailnetAddress, port: f.port })
  expect((await restarted.client.remote.status()).state).toBe('unavailable')
  expect(readFileSync(join(f.home, 'remote', 'identity.json'), 'utf8')).toBe(saved)
})

test('an unprotected or symlinked identity is refused rather than replaced or served', async () => {
  const { renameSync, symlinkSync } = await import('node:fs')
  const f = await listening()
  const path = join(f.home, 'remote', 'identity.json')
  const before = readFileSync(path, 'utf8')
  await f.client.remote.disable()
  chmodSync(path, 0o644)
  await f.client.remote.enable({ address: syntheticTailnetAddress, port: f.port })
  expect((await f.client.remote.status()).state).toBe('unavailable')
  expect(readFileSync(path, 'utf8')).toBe(before)
  chmodSync(path, 0o600)
  renameSync(path, `${path}.saved`)
  symlinkSync(`${path}.saved`, path)
  await f.client.remote.enable({ address: syntheticTailnetAddress, port: f.port })
  expect((await f.client.remote.status()).state).toBe('unavailable')
  expect(readFileSync(`${path}.saved`, 'utf8')).toBe(before)
})

test('disable still closes authenticated WSS when persisting the disabled setting fails', async () => {
  const f = await listening()
  const approved = await f.approved()
  const active = await f.websocket(approved.credential)
  await active.greeting
  const directory = join(f.home, 'remote')
  chmodSync(directory, 0o500)
  onCleanup(() => chmodSync(directory, 0o700))
  await expect(f.client.remote.disable()).rejects.toThrow()
  expect(
    await Promise.race([active.closed.then(() => 'closed'), Bun.sleep(200).then(() => 'open')]),
  ).toBe('closed')
  await expect(f.request('/check', approved.credential)).rejects.toThrow()
})

test('authenticated remote reads share existing lists without writes, require wire compatibility and refuse extra procedures', async () => {
  const f = await listening()
  const { credential } = await f.approved()
  const headers = { 'x-monica-wire-version': '1' }
  expect(
    (await f.request('/workbench/layout/get', secret(), undefined, undefined, headers)).status,
  ).toBe(401)
  expect((await f.request('/workbench/layout/get', credential)).status).toBe(426)
  const empty = await f.request('/workbench/layout/get', credential, undefined, undefined, headers)
  expect(empty.status).toBe(200)
  expect(JSON.parse(empty.body)).toEqual({ runspaces: [] })
  const opened = await f.client.runspace.create({ rows: 24, cols: 80 })
  await f.settled(opened.tab.terminalSessionId)
  for (const [path, expected] of [
    ['layout/get', await f.client.layout.get()],
    ['terminalSession/list', await f.client.terminalSession.list()],
    ['agentSession/list', await f.client.agentSession.list()],
  ] as const) {
    const response = await f.request(
      `/workbench/${path}`,
      credential,
      undefined,
      undefined,
      headers,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual(JSON.parse(JSON.stringify(expected)))
  }
  for (const path of ['runspace/create', 'tab/close', 'agentSession/markSeen', 'remote/invite']) {
    expect(
      (await f.request(`/workbench/${path}`, credential, undefined, undefined, headers)).status,
    ).toBe(404)
  }
  expect(await f.client.layout.get()).toEqual(await f.client.layout.get())
})

test('the remote change socket acknowledges an installed subscription, sees later changes and closes on revocation', async () => {
  const f = await listening()
  const { credential, id } = await f.approved()
  const ws = await f.websocket(credential, '/workbench/changes')
  expect((await ws.greeting).toString()).toContain('"type":"subscribed"')
  const changed = new Promise<Buffer>((resolve) => ws.socket.once('data', resolve))
  await f.client.runspace.create({ rows: 24, cols: 80 })
  expect((await changed).toString()).toContain('"type":"changed"')
  await f.client.remote.revoke({ id })
  await Promise.race([
    ws.closed,
    Bun.sleep(200).then(() => {
      throw new Error('socket not closed')
    }),
  ])
  expect(
    (
      await f.request('/workbench/layout/get', credential, undefined, undefined, {
        'x-monica-wire-version': '1',
      })
    ).status,
  ).toBe(401)
})

test('RemoteWorkbench.observe reads the real empty Ledger without creating a Runspace and follows Mac changes without desktop mutations', async () => {
  const f = await listening()
  const { credential } = await f.approved()
  const states: RemoteState[] = []
  let notify: (() => void) | undefined
  const remote = new RemoteWorkbench({
    async terminal() {
      throw new Error('not used by observation')
    },
    async subscribe(changed, signal) {
      const ws = await f.websocket(credential, '/workbench/changes')
      signal.addEventListener('abort', () => ws.socket.destroy(), { once: true })
      ws.socket.on('data', (data) => {
        if (data.toString().includes('"type":"changed"')) changed()
      })
      expect((await ws.greeting).toString()).toContain('"type":"subscribed"')
    },
    async read(path) {
      const response = await f.request(`/workbench/${path}`, credential, undefined, undefined, {
        'x-monica-wire-version': '1',
      })
      expect(response.status).toBe(200)
      return JSON.parse(response.body)
    },
  })
  const stop = remote.observe((state) => {
    states.push(state)
    notify?.()
  })
  onCleanup(stop)
  const until = async (predicate: (state: RemoteState) => boolean) => {
    if (states.some(predicate)) return
    await new Promise<void>((resolve) => {
      notify = () => {
        if (states.some(predicate)) resolve()
      }
    })
  }
  await until((state) => state.state === 'available' && state.layout.runspaces.length === 0)
  expect(await f.client.layout.get()).toEqual({ runspaces: [] })
  const created = await f.client.runspace.create({ rows: 24, cols: 80 })
  await f.settled(created.tab.terminalSessionId)
  await until(
    (state) =>
      state.state === 'available' &&
      state.layout.runspaces.some((item) => item.id === created.runspaceId) &&
      state.terminalSessions.some((item) => item.status === 'running'),
  )
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest']) {
    await f.client.agentSession.recordHook({
      terminalSessionId: created.tab.terminalSessionId,
      payload: {
        session_id: 'remote-agent',
        hook_event_name,
        cwd: '/work',
        tool_name: 'Bash',
        source: 'startup',
      },
    })
  }
  await until(
    (state) =>
      state.state === 'available' &&
      state.agentSessions.some((item) => item.sessionId === 'remote-agent' && item.unread),
  )
  expect(
    (await f.client.agentSession.list()).find((item) => item.sessionId === 'remote-agent')?.unread,
  ).toBe(true)
  stop()
  const checkpoint = await f.client.tab.open({ runspaceId: created.runspaceId, rows: 24, cols: 80 })
  await f.ptyd.received(
    (op) => op.op === 'create' && op.session_id === checkpoint.terminalSessionId,
  )
  expect(f.ptyd.receivedAll((op) => ['terminate', 'reap', 'shutdown'].includes(op.op))).toEqual([])
})

test('RemoteWorkbench.observe receives a complete UTF-8 Layout larger than one remote frame from the real Ledger', async () => {
  const f = await listening()
  const { credential } = await f.approved()
  for (let i = 0; i < 12; i++)
    await f.client.runspace.create({
      cwd: `/large-${i}-` + 'あ😀'.repeat(1000),
      rows: 24,
      cols: 80,
    })
  const expected = await f.client.layout.get()
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(65536)
  const result = Promise.withResolvers<RemoteState>()
  const remote = new RemoteWorkbench({
    async terminal() {
      throw new Error('not used by observation')
    },
    async subscribe(changed, signal) {
      const ws = await f.websocket(credential, '/workbench/changes')
      signal.addEventListener('abort', () => ws.socket.destroy(), { once: true })
      ws.socket.on('data', (data) => {
        if (data.toString().includes('"type":"changed"')) changed()
      })
      await ws.greeting
    },
    async read(path) {
      const response = await f.request(`/workbench/${path}`, credential, undefined, undefined, {
        'x-monica-wire-version': '1',
      })
      expect(response.status).toBe(200)
      return JSON.parse(response.body)
    },
  })
  const stop = remote.observe((state) => {
    if (state.state === 'available') result.resolve(state)
  })
  onCleanup(stop)
  expect(await result.promise).toMatchObject({ state: 'available', layout: expected })
  expect(await f.client.layout.get()).toEqual(expected)
})

let relayBuilt = false
async function terminalFixture() {
  if (!relayBuilt) {
    const build = Bun.spawn(
      ['cargo', 'build', '-p', 'monica-terminal-client', '--example', 'remote-fixture'],
      { env: process.env, stdout: 'ignore', stderr: 'inherit' },
    )
    expect(await build.exited).toBe(0)
    relayBuilt = true
  }
  const shell = { path: '', secret: '' }
  const f = await listening(shell)
  const relay = Bun.spawn(['target/debug/examples/remote-fixture', f.home], {
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  stopShells.push(async () => {
    await relay.stdin.end()
    await relay.exited
  })
  const reader = relay.stdout.getReader()
  const first = await reader.read()
  Object.assign(shell, JSON.parse(new TextDecoder().decode(first.value)))
  reader.releaseLock()
  const approved = await f.approved()
  await f.workbenchLedger.start()
  await f.client.runspace.create({ cwd: '/remote-test', rows: 31, cols: 97 })
  const tab = (await f.client.layout.get()).runspaces[0]!.tabs[0]!
  await f.settled(tab.terminalSessionId)
  const target = { tabId: tab.id, terminalSessionId: tab.terminalSessionId }
  async function terminal(): Promise<TerminalStream> {
    const Socket = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket
    }
    const socket = new Socket(`wss://127.0.0.1:${f.port}/workbench/terminal`, {
      headers: { authorization: `Bearer ${approved.credential}`, 'x-monica-wire-version': '1' },
      tls: { ca: f.identity.cert, serverName: syntheticTailnetAddress },
    })
    onCleanup(() => socket.close())
    const frames: unknown[] = []
    let waiting: ReturnType<typeof Promise.withResolvers<unknown>> | undefined
    const closed = Promise.withResolvers<boolean>()
    let confirmed = false
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.type === 'closed') {
        confirmed = true
        closed.resolve(true)
      }
      if (waiting) {
        waiting.resolve(frame)
        waiting = undefined
      } else frames.push(frame)
    })
    socket.addEventListener('close', () => {
      closed.resolve(confirmed)
      waiting?.reject(new Error('closed'))
    })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', reject)
    })
    socket.send(JSON.stringify({ type: 'open', ...target }))
    return {
      async prepare() {
        socket.send('{"type":"prepare"}')
      },
      async input(command) {
        socket.send(JSON.stringify(command))
      },
      async next() {
        if (frames.length) return frames.shift()
        waiting = Promise.withResolvers<unknown>()
        return waiting.promise
      },
      async ack(sequence) {
        socket.send(JSON.stringify({ type: 'ack', sequence }))
      },
      async close() {
        if (!confirmed && socket.readyState === WebSocket.OPEN) socket.send('{"type":"close"}')
        return closed.promise
      },
    }
  }
  const remote = new RemoteWorkbench({
    terminal,
    async read() {
      return []
    },
    async subscribe() {},
  })
  async function rendererControl(action: 'ready' | 'stall' | 'disconnect') {
    await relay.stdin.write(
      `${JSON.stringify({ rendererControl: action, session: target.terminalSessionId })}\n`,
    )
    const response = relay.stdout.getReader()
    const value = await response.read()
    response.releaseLock()
    return JSON.parse(new TextDecoder().decode(value.value))
  }
  return { ...f, ...approved, shell, target, terminal, remote, relay, rendererControl }
}

test('RemoteWorkbench.openTerminal orders pre-response and replay-time live output after replay and detaches without lifecycle operations', async () => {
  const f = await terminalFixture()
  f.ptyd.output(f.target.terminalSessionId, 'retained-tail')
  const releaseAttach = f.ptyd.holdNext('attach')
  const replay = Promise.withResolvers<void>()
  const parsing = Promise.withResolvers<void>()
  const live = Promise.withResolvers<void>()
  const rendered: string[] = []
  const sizes: number[][] = []
  const view = f.remote.openTerminal(f.target, {
    size: (rows, cols) => sizes.push([rows, cols]),
    async write(bytes) {
      const text = new TextDecoder().decode(bytes)
      rendered.push(text)
      if (text === 'retained-tail') {
        parsing.resolve()
        await replay.promise
      }
      if (text.includes('during-replay')) live.resolve()
    },
    state() {},
  })
  await f.ptyd.received((op) => op.op === 'attach')
  f.ptyd.output(f.target.terminalSessionId, 'before-response')
  releaseAttach()
  await parsing.promise
  f.ptyd.output(f.target.terminalSessionId, 'during-replay')
  expect(rendered).toEqual(['retained-tail'])
  replay.resolve()
  await live.promise
  expect(rendered.join('')).toBe('retained-tailbefore-responseduring-replay')
  expect(sizes).toEqual([[31, 97]])
  expect(await view.close()).toBe(true)
  expect(f.ptyd.receivedAll((op) => op.op === 'attach')).toHaveLength(1)
  await f.client.runspace.create({ cwd: '/barrier', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(
    f.ptyd.receivedAll((op) =>
      ['terminate', 'reap', 'shutdown', 'write', 'resize'].includes(op.op),
    ),
  ).toEqual([])
  expect(f.ptyd.sessions[0]).toMatchObject({ running: true, rows: 31, cols: 97 })
  expect(f.ptyd.connections).toBe(1)
})

test('remote size initialization discards an older List read-back when Mac resizes during it', async () => {
  const f = await terminalFixture()
  const release = f.ptyd.holdNext('list')
  const sized = Promise.withResolvers<void>()
  const sizes: number[][] = []
  const view = f.remote.openTerminal(f.target, {
    async write() {},
    state() {},
    size(rows, cols) {
      sizes.push([rows, cols])
      sized.resolve()
    },
  })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'list')
  await f.relay.stdin.write(
    `${JSON.stringify({ op: 'resize', session_id: f.target.terminalSessionId, rows: 42, cols: 111 })}\n`,
  )
  await f.ptyd.received((op) => op.op === 'resize')
  release()
  await sized.promise
  expect(sizes).toEqual([[42, 111]])
  expect(await view.close()).toBe(true)
  expect(f.ptyd.receivedAll((op) => op.op === 'list').length).toBeGreaterThanOrEqual(3)
})

test('a view closed while Attach is pending delivers Shell cleanup ACK without waiting for the reply and never writes replay', async () => {
  const f = await terminalFixture()
  const release = f.ptyd.holdNext('attach')
  const writes: string[] = []
  const view = f.remote.openTerminal(f.target, {
    async write(bytes) {
      writes.push(new TextDecoder().decode(bytes))
    },
    size() {},
    state() {},
  })
  await f.ptyd.received((op) => op.op === 'attach')
  expect(await view.close()).toBe(true)
  expect(writes).toEqual([])
  release()
  expect(f.ptyd.connections).toBe(1)
})

test('revocation denies new requests first and confirms Shell detach while replay parsing is held', async () => {
  const f = await terminalFixture()
  f.ptyd.output(f.target.terminalSessionId, 'held-replay')
  const parsing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const view = f.remote.openTerminal(f.target, {
    async write() {
      parsing.resolve()
      await release.promise
    },
    size() {},
    state() {},
  })
  await parsing.promise
  const revoking = f.client.remote.revoke({ id: f.id })
  expect((await f.request('/check', f.credential)).status).toBe(401)
  await revoking
  expect(
    (await f.client.remote.status()).devices.find((device) => device.id === f.id)?.detachPending,
  ).toBe(false)
  expect(f.ptyd.connections).toBe(1)
  release.resolve()
  await view.close()
})

test('remote Exit follows all replay and live output before dedicated cleanup', async () => {
  const f = await terminalFixture()
  f.ptyd.output(f.target.terminalSessionId, 'tail')
  const parsed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const events: string[] = []
  const view = f.remote.openTerminal(f.target, {
    async write(bytes) {
      events.push(new TextDecoder().decode(bytes))
      if (events.length === 1) {
        parsed.resolve()
        await release.promise
      }
    },
    size() {},
    state(state) {
      if (state === 'exited') {
        events.push('exit')
        exited.resolve()
      }
    },
  })
  await parsed.promise
  f.ptyd.output(f.target.terminalSessionId, 'last-live')
  f.ptyd.exit(f.target.terminalSessionId, 0)
  release.resolve()
  await exited.promise
  expect(events).toEqual(['tail', 'last-live', 'exit'])
  await view.close()
  expect(f.ptyd.receivedAll((op) => op.op === 'attach')).toHaveLength(1)
})

test('a stalled phone draw ACK closes only its dedicated connection when the bounded live queue fills', async () => {
  const f = await terminalFixture()
  const stream = await f.terminal()
  await stream.next()
  for (let i = 0; i < 30; i++) f.ptyd.output(f.target.terminalSessionId, new Uint8Array(45 * 1024))
  await expect(stream.next()).rejects.toThrow('closed')
  await f.client.runspace.create({ cwd: '/desktop-still-works', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(f.ptyd.sessions[0]).toMatchObject({ running: true, rows: 31, cols: 97 })
  expect(f.ptyd.receivedAll((op) => ['terminate', 'reap', 'shutdown'].includes(op.op))).toEqual([])
})

test('lost Shell detach ACK leaves a revoked device denied and explicitly pending rather than reporting completion', async () => {
  const f = await terminalFixture()
  const realPath = f.shell.path
  const proxyPath = join(f.home, 'ack-loss.sock')
  const peers = new Set<ReturnType<typeof connect>>()
  const proxy = createServer((backend) => {
    const shell = connect(realPath)
    peers.add(shell)
    peers.add(backend)
    backend.pipe(shell)
    let buffered = ''
    shell.on('data', (data) => {
      buffered += data.toString()
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (JSON.parse(line).type !== 'closed') backend.write(`${line}\n`)
      }
    })
    shell.on('end', () => backend.end())
    shell.on('error', () => backend.destroy())
    backend.on('error', () => shell.destroy())
  })
  onCleanup(() => {
    for (const peer of peers) peer.destroy()
    proxy.close()
  })
  await new Promise<void>((resolve) => proxy.listen(proxyPath, resolve))
  chmodSync(proxyPath, 0o600)
  f.shell.path = proxyPath
  const stream = await f.terminal()
  await stream.next()
  expect(await f.client.remote.revoke({ id: f.id })).toEqual({ state: 'detach-pending' })
  const status = await f.client.remote.status()
  expect(status.detachPending).toBe(true)
  expect(status.devices.find((device) => device.id === f.id)).toMatchObject({
    detachPending: true,
    revokedAt: expect.any(Date),
  })
  expect((await f.request('/check', f.credential)).status).toBe(401)
  expect(f.ptyd.connections).toBe(1)
})

test('the private Shell socket refuses a wrong secret and an unprotected endpoint without attaching', async () => {
  const f = await terminalFixture()
  const before = f.ptyd.receivedAll((op) => op.op === 'hello').length
  const attacker = connect(f.shell.path)
  const ended = new Promise<void>((resolve) => attacker.once('close', resolve))
  attacker.on('error', () => {})
  attacker.write(
    `${JSON.stringify({ secret: '0'.repeat(64), session: f.target.terminalSessionId })}\n`,
  )
  await ended
  chmodSync(f.shell.path, 0o666)
  const stream = await f.terminal()
  await expect(stream.next()).rejects.toThrow('closed')
  await f.client.runspace.create({ cwd: '/auth-barrier', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(f.ptyd.receivedAll((op) => op.op === 'hello')).toHaveLength(before)
  expect(f.ptyd.receivedAll((op) => op.op === 'attach')).toEqual([])
})

test('large UTF-8 replay is split below 64KiB and switching views creates a fresh single attachment', async () => {
  const f = await terminalFixture()
  const tail = Buffer.from('あ😀'.repeat(45000)).subarray(-262144)
  f.ptyd.output(f.target.terminalSessionId, tail)
  const stream = await f.terminal()
  const chunks: Buffer[] = []
  for (;;) {
    const frame = (await stream.next()) as { type: string; sequence: number; data?: string }
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(65536)
    if (frame.type === 'output') {
      const bytes = Buffer.from(frame.data!, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(65536)
      chunks.push(bytes)
    }
    await stream.ack(frame.sequence)
    if (frame.type === 'replay_end') break
  }
  expect(Buffer.concat(chunks)).toEqual(tail)
  expect(chunks.length).toBeGreaterThan(1)
  expect(await stream.close()).toBe(true)
  const next = await f.terminal()
  await next.next()
  expect(await next.close()).toBe(true)
  expect(f.ptyd.receivedAll((op) => op.op === 'attach')).toHaveLength(2)
  expect(f.ptyd.connections).toBe(1)
})

test('missing draw acknowledgements time out and remote disable releases the Shell while desktop stays running', async () => {
  const f = await terminalFixture()
  const stream = await f.terminal()
  await stream.next()
  const closed = await stream.next()
  expect(closed).toMatchObject({ type: 'closed' })
  expect(f.ptyd.connections).toBe(1)
  const next = await f.terminal()
  await next.next()
  await f.client.remote.disable()
  expect((await f.client.remote.status()).detachPending).toBe(false)
  expect(f.ptyd.connections).toBe(1)
  expect(f.ptyd.sessions[0]).toMatchObject({ running: true, rows: 31, cols: 97 })
})

test('successful local resize notification is not treated as applied until asynchronous List reads the new grid', async () => {
  const f = await terminalFixture()
  const applyResize = f.ptyd.holdNext('resize')
  await f.relay.stdin.write(
    `${JSON.stringify({ op: 'resize', session_id: f.target.terminalSessionId, rows: 45, cols: 123 })}\n`,
  )
  await f.ptyd.received((op) => op.op === 'resize')
  const sizes: number[][] = []
  const sized = Promise.withResolvers<void>()
  const view = f.remote.openTerminal(f.target, {
    async write() {},
    state() {},
    size(rows, cols) {
      sizes.push([rows, cols])
      sized.resolve()
    },
  })
  await f.ptyd.receivedAtLeast(3, (op) => op.op === 'list')
  expect(sizes).toEqual([])
  applyResize()
  await sized.promise
  expect(sizes).toEqual([[45, 123]])
  expect(await view.close()).toBe(true)
})

test('RemoteWorkbench.input reaches the existing session once through authenticated WSS and stops on a stalled Mac renderer', async () => {
  const f = await terminalFixture()
  const ready = Promise.withResolvers<void>()
  const unavailable = Promise.withResolvers<void>()
  let wasReady = false
  const view = f.remote.openTerminal(f.target, {
    async write() {},
    size() {},
    state() {},
    inputReady(value) {
      if (value) {
        wasReady = true
        ready.resolve()
      } else if (wasReady) unavailable.resolve()
    },
  })
  expect(await view.input(new TextEncoder().encode('before'))).toBe('not-sent')
  await f.rendererControl('ready')
  await ready.promise
  expect(await view.input(new Uint8Array(65537))).toBe('not-sent')
  const bytes = new TextEncoder().encode('é'.repeat(32768))
  expect(await view.input(bytes)).toBe('accepted')
  await f.ptyd.received((op) => op.op === 'write')
  const writes = f.ptyd.receivedAll((op) => op.op === 'write')
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    op: 'write',
    session_id: f.target.terminalSessionId,
    data: Buffer.from(bytes).toString('base64'),
  })
  expect(await view.input(new TextEncoder().encode('second\r'))).toBe('accepted')
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'write')
  expect(
    f.ptyd.receivedAll((op) => op.op === 'write').map((op) => (op.op === 'write' ? op.data : null)),
  ).toEqual([Buffer.from(bytes).toString('base64'), btoa('second\r')])
  await f.rendererControl('stall')
  await unavailable.promise
  expect(await view.input(new TextEncoder().encode('after'))).toBe('not-sent')
  expect(await view.close()).toBe(true)
  await f.client.runspace.create({ cwd: '/input-barrier', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(f.ptyd.receivedAll((op) => op.op === 'write')).toHaveLength(2)
})

test('a lost input acceptance ACK is uncertain and never resent through the real authenticated relay', async () => {
  const f = await terminalFixture()
  const ready = Promise.withResolvers<void>()
  const lost = Promise.withResolvers<void>()
  const remote = new RemoteWorkbench({
    async read() {
      return []
    },
    async subscribe() {},
    async terminal() {
      const stream = await f.terminal()
      return {
        ...stream,
        async next() {
          for (;;) {
            const frame = await stream.next()
            if (
              typeof frame === 'object' &&
              frame &&
              'type' in frame &&
              frame.type === 'input_result'
            ) {
              lost.resolve()
              continue
            }
            return frame
          }
        },
      }
    },
  })
  const view = remote.openTerminal(f.target, {
    async write() {},
    size() {},
    state() {},
    inputReady(value) {
      if (value) ready.resolve()
    },
  })
  await f.rendererControl('ready')
  await ready.promise
  const result = view.input(new TextEncoder().encode('only-once\r'))
  await lost.promise
  expect(await view.close()).toBe(true)
  expect(await result).toBe('uncertain')
  expect(await view.input(new TextEncoder().encode('offline'))).toBe('not-sent')
  await f.ptyd.received((op) => op.op === 'write')
  expect(f.ptyd.receivedAll((op) => op.op === 'write')).toHaveLength(1)
})

test('the Shell rejects replaced renderer generations and revocation precedes every later input admission', async () => {
  const f = await terminalFixture()
  const stream = await f.terminal()
  const first = await f.rendererControl('ready')
  await stream.prepare()
  async function frameOf(type: string) {
    for (;;) {
      const frame = TerminalFrameSchema.parse(await stream.next())
      if ('sequence' in frame) await stream.ack(frame.sequence)
      if (frame.type === type) return frame
    }
  }
  await frameOf('renderer')
  const replacement = await f.rendererControl('ready')
  await frameOf('renderer')
  await stream.input({ type: 'input', id: 1, generation: first.generation, data: btoa('stale') })
  expect(await frameOf('input_result')).toMatchObject({ result: 'not-sent' })
  await stream.input({
    type: 'input',
    id: 2,
    generation: replacement.generation,
    data: btoa('admitted-before-revoke'),
  })
  expect(await frameOf('input_result')).toMatchObject({ result: 'accepted' })
  await f.ptyd.received((op) => op.op === 'write')
  expect(await f.client.remote.revoke({ id: f.id })).toMatchObject({ state: 'detached' })
  await stream
    .input({ type: 'input', id: 3, generation: replacement.generation, data: btoa('after-revoke') })
    .catch(() => {})
  await f.client.runspace.create({ cwd: '/revoke-input-barrier', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(f.ptyd.receivedAll((op) => op.op === 'write')).toEqual([
    { op: 'write', session_id: f.target.terminalSessionId, data: btoa('admitted-before-revoke') },
  ])
})

test('input admitted before revocation may arrive during detach, but no later input reaches the Shell before or after cleanup ACK', async () => {
  const f = await terminalFixture()
  const realPath = f.shell.path
  const proxyPath = join(f.home, 'input-admission.sock')
  const admitted = Promise.withResolvers<void>()
  const peers = new Set<ReturnType<typeof connect>>()
  let release: (() => void) | undefined
  let inputs = 0
  const proxy = createServer((backend) => {
    const shell = connect(realPath)
    peers.add(shell)
    peers.add(backend)
    shell.pipe(backend)
    let buffered = ''
    const held: string[] = []
    let paused = false
    release = () => {
      paused = false
      for (const line of held.splice(0)) shell.write(`${line}\n`)
    }
    backend.on('data', (data) => {
      buffered += data.toString()
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (JSON.parse(line).type === 'input') {
          inputs++
          paused = true
          admitted.resolve()
        }
        if (paused) held.push(line)
        else shell.write(`${line}\n`)
      }
    })
    shell.on('error', () => backend.destroy())
    backend.on('error', () => shell.destroy())
  })
  onCleanup(() => {
    for (const peer of peers) peer.destroy()
    proxy.close()
  })
  await new Promise<void>((resolve) => proxy.listen(proxyPath, resolve))
  chmodSync(proxyPath, 0o600)
  f.shell.path = proxyPath
  const stream = await f.terminal()
  const ready = await f.rendererControl('ready')
  await stream.prepare()
  for (;;) {
    const frame = TerminalFrameSchema.parse(await stream.next())
    if ('sequence' in frame) await stream.ack(frame.sequence)
    if (frame.type === 'renderer' && frame.generation) break
  }
  await stream.input({ type: 'input', id: 1, generation: ready.generation, data: btoa('before') })
  await admitted.promise
  const revoking = f.client.remote.revoke({ id: f.id })
  expect((await f.request('/check', f.credential)).status).toBe(401)
  await stream
    .input({ type: 'input', id: 2, generation: ready.generation, data: btoa('during') })
    .catch(() => {})
  release!()
  expect(await revoking).toEqual({ state: 'detached' })
  await stream
    .input({ type: 'input', id: 3, generation: ready.generation, data: btoa('after') })
    .catch(() => {})
  await f.client.runspace.create({ cwd: '/admission-barrier', rows: 24, cols: 80 })
  await f.ptyd.receivedAtLeast(2, (op) => op.op === 'create')
  expect(inputs).toBe(1)
  expect(f.ptyd.receivedAll((op) => op.op === 'write')).toEqual([
    { op: 'write', session_id: f.target.terminalSessionId, data: btoa('before') },
  ])
  expect(f.ptyd.connections).toBe(1)
})
