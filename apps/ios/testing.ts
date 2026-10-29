import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkbenchLedger, router, migrations } from '@monica/workbench/server'
import { startFakePtyd } from '@monica/workbench/testing'
import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

const home = mkdtempSync(join(tmpdir(), 'monica-455-tls-'))
const servers: ReturnType<typeof Bun.serve>[] = []
const credential = `monica-remote-v1.${randomBytes(32).toString('hex')}`
const audit: Record<string, number> = {
  'cancel-started': 0,
  cancelled: 0,
  'wrong-identity': 0,
  expired: 0,
  hostname: 0,
  'redirect-target': 0,
}
function openssl(args: string[]) {
  const result = Bun.spawnSync(['/usr/bin/openssl', ...args], { env: process.env })
  if (!result.success) throw new Error(result.stderr.toString())
}
function identity(name: string, host = '127.0.0.1', expired = false) {
  const key = join(home, `${name}.key`)
  const cert = join(home, `${name}.pem`)
  if (!expired) {
    openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=monica test',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-addext',
      `subjectAltName=IP:${host}${name === 'good' ? `,IP:${[100, 64, 0, 1].join('.')}` : ''}`,
      '-keyout',
      key,
      '-out',
      cert,
    ])
  } else {
    const csr = join(home, 'expired.csr')
    const config = join(home, 'ca.cnf')
    writeFileSync(join(home, 'index'), '')
    writeFileSync(join(home, 'serial'), '01\n')
    writeFileSync(
      config,
      `[ca]\ndefault_ca=CA\n[CA]\ndatabase=${home}/index\nserial=${home}/serial\nnew_certs_dir=${home}\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:${host}\nextendedKeyUsage=serverAuth\n`,
    )
    openssl([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-nodes',
      '-subj',
      '/CN=monica expired',
      '-keyout',
      key,
      '-out',
      csr,
    ])
    openssl([
      'ca',
      '-batch',
      '-selfsign',
      '-config',
      config,
      '-keyfile',
      key,
      '-in',
      csr,
      '-out',
      cert,
      '-startdate',
      '20200101000000Z',
      '-enddate',
      '20200102000000Z',
    ])
  }
  const certificate = readFileSync(cert, 'utf8')
  return {
    key: readFileSync(key, 'utf8'),
    cert: certificate,
    der: new X509Certificate(certificate).raw.toString('base64'),
  }
}
const good = identity('good')
const wrong = identity('wrong')
const expired = identity('expired', '127.0.0.1', true)
const syntheticAddress = [100, 64, 0, 1].join('.')
const hostname = identity('hostname', syntheticAddress)
let revoked = false
const sockets = new Set<{ close(code: number): void }>()
const fixtures: Record<string, { endpoint: string; certificate: string; credential: string }> = {}
function frame(value: unknown, end = true) {
  const bytes = Buffer.from(JSON.stringify(value))
  const lines: string[] = []
  for (let offset = 0, index = 0; offset < bytes.length; offset += 45 * 1024, index++) {
    lines.push(
      JSON.stringify({
        version: 1,
        type: 'data',
        index,
        data: bytes.subarray(offset, offset + 45 * 1024).toString('base64'),
      }),
    )
  }
  if (end) lines.push(JSON.stringify({ version: 1, type: 'end', count: lines.length }))
  return lines.join('\n') + '\n'
}
function response(value: unknown) {
  return new Response(frame(value), { headers: { 'content-type': 'application/x-ndjson' } })
}
function serve(name: string, tls: typeof good, pinned = tls, redirect?: string) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls,
    fetch(request, listener) {
      if (name in audit) audit[name] = (audit[name] ?? 0) + 1
      if (name === 'revoked' && revoked) return new Response('Unauthorized', { status: 401 })
      if (name === 'revoked' && new URL(request.url).pathname.endsWith('terminalSession/list')) {
        revoked = true
        for (const socket of sockets) socket.close(1008)
      }
      if (request.headers.get('authorization') !== `Bearer ${credential}`)
        return new Response('Unauthorized', { status: 401 })
      if (redirect) return Response.redirect(redirect, 302)
      if (request.headers.get('upgrade') === 'websocket') {
        if (listener.upgrade(request, { data: {} })) return undefined
      }
      if (name === 'audit') return response(audit)
      if (name === 'truncated')
        return new Response(frame({ runspaces: [] }, false), {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      if (name === 'oversized')
        return new Response('x'.repeat(65537) + '\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      if (name === 'cancel') {
        audit['cancel-started'] = 1
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(frame({ runspaces: [] }, false)))
            },
            cancel() {
              audit.cancelled = 1
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        )
      }
      return response({ runspaces: [] })
    },
    websocket: {
      open(socket) {
        if (name === 'revoked') sockets.add(socket)
        socket.send(JSON.stringify({ version: 1, type: 'subscribed' }))
      },
      message() {},
    },
  })
  servers.push(server)
  fixtures[name] = {
    endpoint: `https://127.0.0.1:${server.port}`,
    certificate: pinned.der,
    credential,
  }
  return `https://127.0.0.1:${server.port}/workbench/layout/get`
}
serve('valid', good)
serve('wrong-identity', wrong, good)
serve('expired', expired)
serve('hostname', hostname)
const redirectTarget = serve('redirect-target', good)
serve('redirect', good, good, redirectTarget)
serve('audit', good)
serve('truncated', good)
serve('oversized', good)
serve('cancel', good)
serve('revoked', good)
fixtures.qr = {
  endpoint: `https://${syntheticAddress}:19443`,
  certificate: hostname.der,
  credential,
}
const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = ON')
const db = drizzle(sqlite)
migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
const ptydHome = mkdtempSync(join(tmpdir(), 'm455-'))
const ptyd = startFakePtyd(ptydHome)
const ledger = createWorkbenchLedger({
  db,
  home: ptydHome,
  ptydPath: join(ptydHome, 'no-ptyd'),
  notify: () => {},
  nameAgentSession: () => null,
  unread: () => {},
})
const client = createRouterClient(router, { context: { db, workbenchLedger: ledger } })
const remoteDirectory = join(ptydHome, 'remote')
mkdirSync(remoteDirectory, { mode: 0o700 })
writeFileSync(
  join(remoteDirectory, 'identity.json'),
  JSON.stringify({ key: good.key, cert: good.cert }),
  { mode: 0o600 },
)
const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const port = free.port!
await free.stop(true)
const originalServe = Bun.serve
const bind = spyOn(Bun, 'serve').mockImplementation((options) =>
  originalServe(Object.assign(options, { hostname: '127.0.0.1' })),
)
try {
  await client.remote.enable({ address: syntheticAddress, port })
} finally {
  bind.mockRestore()
}
const invitation = JSON.parse((await client.remote.invite()).payload).invitation as string
const registration = await new Promise<string>((resolve, reject) => {
  const request = https.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/registration/request',
      method: 'POST',
      ca: good.cert,
      headers: {
        authorization: `Bearer ${credential}`,
        'x-monica-invitation': invitation,
        'content-type': 'application/json',
      },
    },
    (res) => {
      let text = ''
      res.on('data', (data) => {
        text += data
      })
      res.on('end', () => resolve(text))
    },
  )
  request.on('error', reject)
  request.end(JSON.stringify({ version: 1, name: 'Simulator' }))
})
await client.remote.approve({ id: JSON.parse(registration).id })
for (let i = 0; i < 12; i++)
  await client.runspace.create({
    cwd: `/simulator-${i}-` + 'あ😀'.repeat(1000),
    rows: 24,
    cols: 80,
  })
fixtures.large = { endpoint: `https://127.0.0.1:${port}`, certificate: good.der, credential }
writeFileSync(join(import.meta.dir, 'Tests/fixtures.json'), JSON.stringify(fixtures))
process.stdout.write('Native HTTPS/WSS fixtures ready\n')
function stop() {
  ledger.stop()
  ptyd.stop()
  sqlite.close()
  rmSync(ptydHome, { recursive: true, force: true })
  for (const server of servers) void server.stop(true)
  rmSync(home, { recursive: true, force: true })
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
