import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'monica-455-tls-'))
const servers: ReturnType<typeof Bun.serve>[] = []
const credential = `monica-remote-v1.${randomBytes(32).toString('hex')}`
const audit: Record<string, number> = {
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
      `subjectAltName=IP:${host}`,
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
      if (name === 'audit') return Response.json(audit)
      return Response.json({ runspaces: [] })
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
serve('revoked', good)
fixtures.qr = {
  endpoint: `https://${syntheticAddress}:19443`,
  certificate: hostname.der,
  credential,
}
writeFileSync(join(import.meta.dir, '../Tests/fixtures.json'), JSON.stringify(fixtures))
process.stdout.write('Native HTTPS/WSS fixtures ready\n')
function stop() {
  for (const server of servers) void server.stop(true)
  rmSync(home, { recursive: true, force: true })
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
