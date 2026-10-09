import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'monica-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const DEV_ORIGIN = 'chrome-extension://jhcphbonbcemkjkhofopmhbfphenihoj/'

// Chromium の枠: 4 byte の little-endian の長さに UTF-8 の JSON が続く。
function framed(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(4 + json.byteLength)
  new DataView(frame.buffer).setUint32(0, json.byteLength, true)
  frame.set(json, 4)
  return frame
}

function unframed(bytes: Uint8Array): unknown {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
  expect(bytes.byteLength).toBe(4 + length)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4)))
}

// Chromium は host の第 1 引数に呼んだ Chrome Extension の origin を渡し、応答の後に stdin を閉じる。
async function askHost(env: Record<string, string>) {
  const child = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), DEV_ORIGIN], {
    env: { PATH: process.env.PATH!, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await child.stdin.write(framed({}))
  await child.stdin.flush()
  const reply = unframed(new Uint8Array(await new Response(child.stdout).arrayBuffer()))
  await child.stdin.end()
  return { reply, code: await child.exited }
}

function writeEndpoint(home: string, pid: number) {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'backend.json'),
    JSON.stringify({ port: 49152, token: 'full-token', chatToken: 'chat-token', pid }),
  )
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

test('a Chrome Extension that asks the native host gets the port and the chat token of the live Backend of MONICA_HOME, and never the full token', async () => {
  const home = tempDir()
  writeEndpoint(home, process.pid)

  const { reply, code } = await askHost({ MONICA_HOME: home })

  expect(reply).toEqual({ port: 49152, token: 'chat-token' })
  expect(code).toBe(0)
})

// Dock から起こした Brave の env に MONICA_HOME は無く、release の home の Backend を返す。
test('without MONICA_HOME the native host answers with the Backend of ~/.monica', async () => {
  const user = tempDir()
  writeEndpoint(join(user, '.monica'), process.pid)

  const { reply } = await askHost({ HOME: user })

  expect(reply).toEqual({ port: 49152, token: 'chat-token' })
})

test('the native host says the Backend is not running when its home has no backend.json, or one whose pid is dead', async () => {
  const empty = tempDir()
  const stale = tempDir()
  writeEndpoint(stale, await deadPid())

  for (const home of [empty, stale]) {
    const { reply, code } = await askHost({ MONICA_HOME: home })
    expect(reply).toEqual({ error: 'not-running' })
    expect(code).toBe(0)
  }
})
