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
        if (listener.upgrade(request)) return undefined
      }
      if (name === 'audit') return response(audit)
      if (name === 'truncated')
        return new Response(frame({ runspaces: [] }, false), {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      if (name === 'malformed')
        return new Response(JSON.stringify({ version: true, type: 'end', count: false }) + '\n', {
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
serve('malformed', good)
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
const shellProcess = Bun.spawn(['target/debug/examples/remote-fixture', ptydHome], {
  env: process.env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})
const shellReader = shellProcess.stdout.getReader()
const shellEndpoint: { path: string; secret: string } = JSON.parse(
  new TextDecoder().decode((await shellReader.read()).value),
)
shellReader.releaseLock()
const ledgerDeps = {
  shell: shellEndpoint,
  db,
  home: ptydHome,
  ptydPath: join(ptydHome, 'no-ptyd'),
  notify: () => {},
  nameAgentSession: () => null,
  unread: () => {},
}
let ledger = createWorkbenchLedger(ledgerDeps)
let client = createRouterClient(router, { context: { db, workbenchLedger: ledger } })
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
const registration = await registerDevice(credential)
await client.remote.approve({ id: registration.id })
for (let i = 0; i < 12; i++)
  await client.runspace.create({
    cwd: `/simulator-${i}-` + 'あ😀'.repeat(1000),
    rows: 24,
    cols: 80,
  })
fixtures.large = { endpoint: `https://127.0.0.1:${port}`, certificate: good.der, credential }
async function registerDevice(deviceCredential: string) {
  const invitation = JSON.parse((await client.remote.invite()).payload).invitation as string
  return new Promise<{ id: string }>((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/registration/request',
        method: 'POST',
        ca: good.cert,
        headers: {
          authorization: `Bearer ${deviceCredential}`,
          'x-monica-invitation': invitation,
          'content-type': 'application/json',
        },
      },
      (res) => {
        let text = ''
        res.on('data', (data) => {
          text += data
        })
        res.on('end', () => resolve(JSON.parse(text)))
      },
    )
    request.on('error', reject)
    request.end(JSON.stringify({ version: 1, name: 'Lifecycle Simulator' }))
  })
}
const lifecycleCredential = `monica-remote-v1.${randomBytes(32).toString('hex')}`
const lifecycleDevice = await registerDevice(lifecycleCredential)
await client.remote.approve({ id: lifecycleDevice.id })
fixtures.lifecycle = { ...fixtures.large!, credential: lifecycleCredential }
const pendingCredential = `monica-remote-v1.${randomBytes(32).toString('hex')}`
await registerDevice(pendingCredential)
fixtures.pending = { ...fixtures.large!, credential: pendingCredential }
const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: good,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${credential}`)
      return new Response('Unauthorized', { status: 401 })
    if (new URL(request.url).pathname.endsWith('terminalSession/list')) {
      await client.remote.revoke({ id: lifecycleDevice.id })
      const elapsed = Date.now() + 301_000
      spyOn(Date, 'now').mockReturnValue(elapsed)
    }
    return response({})
  },
})
servers.push(control)
fixtures['lifecycle-control'] = {
  endpoint: `https://127.0.0.1:${control.port}`,
  certificate: good.der,
  credential,
}
await ledger.start()
const terminalRunspace = (await client.layout.get()).runspaces[0]!
const terminalTab = terminalRunspace.tabs[0]!
await ptyd.receivedAtLeast(12, (op) => op.op === 'create')
ptyd.output(
  terminalTab.terminalSessionId,
  'retained-phone-tail\r\n\x1b[c\x1b[6n\x1b]10;?\x07\x1b[?u\x1b]52;c;ZXZpbA==\x07',
)
const terminalControl = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: good,
  fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${credential}`)
      return new Response('Unauthorized', { status: 401 })
    const path = new URL(request.url).pathname
    if (path.endsWith('terminalSession/list'))
      ptyd.output(
        terminalTab.terminalSessionId,
        'live-phone-output\r\n\x1b[c\x1b[6n\x1b]10;?\x07\x1b[?u',
      )
    if (path.endsWith('agentSession/list'))
      void shellProcess.stdin.write(
        `${JSON.stringify({ op: 'resize', session_id: terminalTab.terminalSessionId, rows: 31, cols: 97 })}\n`,
      )
    return response({
      target: { tabId: terminalTab.id, terminalSessionId: terminalTab.terminalSessionId },
      connections: ptyd.connections,
      writes: ptyd.receivedAll((op) => op.op === 'write').length,
      lifecycle: ptyd.receivedAll((op) => ['terminate', 'reap', 'shutdown'].includes(op.op)).length,
      sessions: ptyd.sessions,
    })
  },
})
servers.push(terminalControl)
fixtures['terminal-control'] = {
  endpoint: `https://127.0.0.1:${terminalControl.port}`,
  certificate: good.der,
  credential,
}
const inputControl = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: good,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${credential}`)
      return new Response('Unauthorized', { status: 401 })
    const path = new URL(request.url).pathname
    if (path.endsWith('terminalSession/list') || path.endsWith('agentSession/list')) {
      await shellProcess.stdin.write(
        `${JSON.stringify({ rendererControl: path.endsWith('terminalSession/list') ? 'ready' : 'stall', session: terminalTab.terminalSessionId })}\n`,
      )
      const reader = shellProcess.stdout.getReader()
      await reader.read()
      reader.releaseLock()
      ptyd.output(
        terminalTab.terminalSessionId,
        'shared-input-result\r\n\x1b[c\x1b[6n\x1b]10;?\x07\x1b[?u',
      )
    }
    if (path.endsWith('layout/get'))
      await ptyd.received(
        (op) => op.op === 'write' && op.session_id === terminalTab.terminalSessionId,
      )
    return response({
      writes: ptyd.receivedAll((op) => op.op === 'write'),
      connections: ptyd.connections,
    })
  },
})
servers.push(inputControl)
fixtures['input-control'] = {
  endpoint: `https://127.0.0.1:${inputControl.port}`,
  certificate: good.der,
  credential,
}
let normalOutput = 0
const touchControl = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: good,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${credential}`)
      return new Response('Unauthorized', { status: 401 })
    const path = new URL(request.url).pathname
    if (path.endsWith('layout/get')) {
      const checkpoint = await client.tab.open({
        runspaceId: terminalRunspace.id,
        rows: 24,
        cols: 80,
      })
      await ptyd.received(
        (op) => op.op === 'create' && op.session_id === checkpoint.terminalSessionId,
      )
      await client.tab.close({ id: checkpoint.id })
    }
    if (path.endsWith('terminalSession/list'))
      ptyd.output(
        terminalTab.terminalSessionId,
        '\x1b[?1049l\x1b[?1l' +
          Array.from(
            { length: 100 },
            (_, index) => `phone-scroll-${index} ${'wide-'.repeat(30)}\r\n`,
          ).join('') +
          `phone-normal-end-${++normalOutput}`,
      )
    if (path.endsWith('agentSession/list'))
      ptyd.output(
        terminalTab.terminalSessionId,
        '\x1b[?1049h\x1b[?1h\x1b[?1003h\x1b[?1006hphone-tui-mouse',
      )
    return response({
      normalOutput,
      sessions: ptyd.sessions,
      resizes: ptyd.receivedAll((op) => op.op === 'resize').length,
      writes: ptyd.receivedAll((op) => op.op === 'write'),
    })
  },
})
servers.push(touchControl)
fixtures['touch-control'] = {
  endpoint: `https://127.0.0.1:${touchControl.port}`,
  certificate: good.der,
  credential,
}

const reconnectControl = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: good,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${credential}`)
      return new Response('Unauthorized', { status: 401 })
    if (new URL(request.url).pathname.endsWith('terminalSession/list')) {
      ledger.stop()
      ledger = createWorkbenchLedger(ledgerDeps)
      client = createRouterClient(router, { context: { db, workbenchLedger: ledger } })
      const restartBind = spyOn(Bun, 'serve').mockImplementation((options) =>
        originalServe(Object.assign(options, { hostname: '127.0.0.1' })),
      )
      try {
        await ledger.start()
      } finally {
        restartBind.mockRestore()
      }
    }
    return response({
      target: { tabId: terminalTab.id, terminalSessionId: terminalTab.terminalSessionId },
      connections: ptyd.connections,
      creates: ptyd.receivedAll((op) => op.op === 'create').length,
      writes: ptyd.receivedAll((op) => op.op === 'write').length,
      lifecycle: ptyd.receivedAll((op) => ['terminate', 'reap', 'shutdown'].includes(op.op)).length,
    })
  },
})
servers.push(reconnectControl)
fixtures['reconnect-control'] = {
  endpoint: `https://127.0.0.1:${reconnectControl.port}`,
  certificate: good.der,
  credential,
}

writeFileSync(join(import.meta.dir, 'Tests/Fixtures/fixtures.json'), JSON.stringify(fixtures))
process.stdout.write('Native HTTPS/WSS fixtures ready\n')
async function stop() {
  ledger.stop()
  await shellProcess.stdin.end()
  await shellProcess.exited
  ptyd.stop()
  sqlite.close()
  rmSync(ptydHome, { recursive: true, force: true })
  for (const server of servers) void server.stop(true)
  rmSync(home, { recursive: true, force: true })
  process.exit()
}
process.on('SIGTERM', () => {
  void stop()
})
process.on('SIGINT', () => {
  void stop()
})
