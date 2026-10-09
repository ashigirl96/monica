import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { writeDevNativeHost } from './native-host'

const repo = resolve(import.meta.dir, '..')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-host-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function framed(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(4 + json.byteLength)
  new DataView(frame.buffer).setUint32(0, json.byteLength, true)
  frame.set(json, 4)
  return frame
}

test('bun run extension writes a dev manifest that lets only the dev Chrome Extension start a host that names no worktree', () => {
  const dir = tempDir()
  const manifestDir = join(dir, 'Google/Chrome/NativeMessagingHosts')
  const hostPath = join(dir, 'monica-dev/native-host')

  writeDevNativeHost({ manifestDir, hostPath })

  expect(
    JSON.parse(readFileSync(join(manifestDir, 'com.ashigirl96.monica_dev.json'), 'utf8')),
  ).toEqual({
    name: 'com.ashigirl96.monica_dev',
    description: expect.any(String),
    path: hostPath,
    type: 'stdio',
    allowed_origins: ['chrome-extension://jhcphbonbcemkjkhofopmhbfphenihoj/'],
  })
  expect(statSync(hostPath).mode & 0o111).toBe(0o111)
  expect(readFileSync(hostPath, 'utf8')).not.toContain(repo)
})

test('a dev manifest and host already as written are left unwritten', () => {
  const dir = tempDir()
  const manifestDir = join(dir, 'hosts')
  const hostDir = join(dir, 'home')
  writeDevNativeHost({ manifestDir, hostPath: join(hostDir, 'native-host') })
  chmodSync(manifestDir, 0o555)
  chmodSync(hostDir, 0o555)
  cleanups.push(() => {
    chmodSync(manifestDir, 0o755)
    chmodSync(hostDir, 0o755)
  })

  expect(() =>
    writeDevNativeHost({ manifestDir, hostPath: join(hostDir, 'native-host') }),
  ).not.toThrow()
})

// dev の Brave は bun run extension の env を継ぎ、host は Brave の env を継ぐ。
test('the dev host answers with the CLI of the worktree in MONICA_REPO, for the home in MONICA_HOME', async () => {
  const dir = tempDir()
  const hostPath = join(dir, 'native-host')
  writeDevNativeHost({ manifestDir: join(dir, 'hosts'), hostPath })
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, 'backend.json'),
    JSON.stringify({
      port: 49152,
      token: 'full-token',
      extensionToken: 'extension-token',
      pid: process.pid,
    }),
  )

  const host = Bun.spawn([hostPath, 'chrome-extension://jhcphbonbcemkjkhofopmhbfphenihoj/'], {
    env: { PATH: process.env.PATH!, MONICA_REPO: repo, MONICA_HOME: home },
    stdin: framed({}),
    stdout: 'pipe',
  })
  const reply = new Uint8Array(await new Response(host.stdout).arrayBuffer())

  expect(await host.exited).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(reply.subarray(4)))).toEqual({
    port: 49152,
    token: 'extension-token',
  })
})
