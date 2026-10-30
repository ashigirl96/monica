import { createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

const IdentitySchema = z.object({ key: z.string(), cert: z.string() })
export type RemoteIdentity = z.infer<typeof IdentitySchema>

export function remoteDirectory(home: string) {
  const path = join(home, 'remote')
  mkdirSync(path, { mode: 0o700, recursive: true })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('The remote directory must be owned by this user with mode 0700')
  }
  return path
}

export function readProtected(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Remote files must be owned by this user with mode 0600')
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function writeProtected(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function describeIdentity(identity: RemoteIdentity) {
  const cert = new X509Certificate(identity.cert)
  return {
    certificate: cert.raw.toString('base64'),
    fingerprint: cert.fingerprint256,
    expiresAt: cert.validTo,
  }
}

export function loadIdentity(directory: string, address: string): RemoteIdentity {
  const path = join(directory, 'identity.json')
  const saved = readProtected(path)
  let identity: RemoteIdentity
  if (saved !== null) {
    identity = IdentitySchema.parse(JSON.parse(saved))
  } else {
    const temporary = mkdtempSync(join(directory, 'identity-'))
    try {
      const key = join(temporary, 'key.pem')
      const cert = join(temporary, 'cert.pem')
      const result = Bun.spawnSync(
        [
          '/usr/bin/openssl',
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
          '365',
          '-subj',
          '/CN=monica remote',
          '-addext',
          `subjectAltName=IP:${address}`,
          '-addext',
          'basicConstraints=critical,CA:TRUE',
          '-addext',
          'keyUsage=critical,digitalSignature,keyCertSign',
          '-addext',
          'extendedKeyUsage=serverAuth',
          '-keyout',
          key,
          '-out',
          cert,
        ],
        { env: process.env, timeout: 10_000 },
      )
      if (!result.success) throw new Error('The OS could not generate a remote TLS identity')
      identity = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
      writeProtected(path, JSON.stringify(identity))
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  const cert = new X509Certificate(identity.cert)
  const publicKey = createPublicKey(identity.key).export({ type: 'spki', format: 'der' })
  if (
    !cert.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey) ||
    !cert.checkIP(address) ||
    Date.now() < Date.parse(cert.validFrom) ||
    Date.now() >= Date.parse(cert.validTo)
  ) {
    throw new Error(
      'The remote TLS identity is expired or does not match this address; renew and register again',
    )
  }
  return identity
}
