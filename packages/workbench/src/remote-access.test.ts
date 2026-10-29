import { afterEach, expect, setDefaultTimeout, spyOn, test, setSystemTime } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import https from 'node:https'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { checkServerIdentity } from 'node:tls'

import { remoteDevice } from './schema.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

setDefaultTimeout(30_000)
afterEach(() => {
  setSystemTime()
  cleanUp()
})
// Synthetic test address; the bind fixture redirects traffic to isolated loopback.
const syntheticTailnetAddress = [100, 64, 0, 1].join('.')
const secret = () => `monica-remote-v1.${randomBytes(32).toString('hex')}`

async function listening() {
  const fixture = setup()
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
          res.on('end', () => resolve({ status: res.statusCode!, body: text }))
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
  async function websocket(credential: string) {
    return new Promise<{ socket: Duplex; closed: Promise<void>; greeting: Promise<Buffer> }>(
      (resolve, reject) => {
        const req = https.request({
          ...options,
          path: '/check',
          headers: {
            authorization: `Bearer ${credential}`,
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
  const { chmodSync, renameSync, symlinkSync } = await import('node:fs')
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
  const { chmodSync } = await import('node:fs')
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
