import { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MAX_ASK_BODY_BYTES } from '@monica/chat/contract'
import { createChatAgent } from '@monica/chat/server'
import type { contract } from '@monica/note/contract'
import { createNoteLedger, migrations } from '@monica/note/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { listenBrowser } from './browser-listener.ts'
import { freePort } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function webDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'monica-web-dist-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function listen(port: number | undefined, dist = webDist({ 'index.html': '<p>notes</p>' })) {
  const home = mkdtempSync(join(tmpdir(), 'monica-home-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home })
  const chatAgent = createChatAgent({ home })
  const listener = listenBrowser(port?.toString(), {
    context: { db, noteLedger, chatAgent },
    webDist: dist,
  })
  if (listener) cleanups.push(() => listener.stop())
  return { listener, home }
}

test('the browser listener answers on both loopbacks to the three names of its port and refuses any other Host', async () => {
  const port = freePort()
  listen(port)

  const status = async (address: string, host: string) =>
    (await fetch(`http://${address}:${port}/`, { headers: { host } })).status

  for (const address of ['127.0.0.1', '[::1]']) {
    expect(await status(address, `monica.localhost:${port}`)).toBe(200)
    expect(await status(address, `localhost:${port}`)).toBe(200)
    expect(await status(address, `127.0.0.1:${port}`)).toBe(200)
    expect(await status(address, `evil.example:${port}`)).toBe(403)
    expect(await status(address, `monica.localhost:${port + 1}`)).toBe(403)
  }
})

// 外の site からの top-level の form POST は loopback まで届き、user が起こす navigation には none が付く（docs/research/browser-loopback.md、ADR-0028）。
test('a request other than GET runs a note procedure only from the same origin or from a Chrome Extension', async () => {
  const port = freePort()
  listen(port)

  const openDaily = (site?: string, mode?: string) =>
    fetch(`http://127.0.0.1:${port}/rpc/note/daily/open`, {
      method: 'POST',
      headers: {
        host: `monica.localhost:${port}`,
        'content-type': 'application/json',
        ...(site && { 'sec-fetch-site': site }),
        ...(mode && { 'sec-fetch-mode': mode }),
      },
      body: JSON.stringify({ json: { date: '2026-10-06' } }),
    })

  const cases: [site: string | undefined, mode: string | undefined, status: number][] = [
    ['same-origin', undefined, 200],
    ['same-origin', 'cors', 200],
    ['none', 'cors', 200],
    ['none', undefined, 403],
    ['none', 'navigate', 403],
    ['none', 'no-cors', 403],
    ['same-site', 'cors', 403],
    ['cross-site', 'cors', 403],
    [undefined, undefined, 403],
  ]
  for (const [site, mode, status] of cases) {
    expect([site, mode, (await openDaily(site, mode)).status]).toEqual([site, mode, status])
  }
})

test('a GET for a path of the SPA gets index.html uncached, and a hashed asset is cached for good', async () => {
  const dist = webDist({
    'index.html': '<p>notes</p>',
    'assets/index-B1x2c3.js': 'export {}',
    'favicon.svg': '<svg/>',
  })
  const port = freePort()
  listen(port, dist)

  const get = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `monica.localhost:${port}` } })

  for (const path of ['/', '/essays/note-1', '/index.html']) {
    const page = await get(path)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toStartWith('text/html')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toBe('<p>notes</p>')
  }

  const asset = await get('/assets/index-B1x2c3.js')
  expect(asset.headers.get('content-type')).toStartWith('text/javascript')
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await asset.text()).toBe('export {}')

  // public/ から来る file には hash が無い。
  const favicon = await get('/favicon.svg')
  expect(favicon.headers.get('content-type')).toStartWith('image/svg+xml')
  expect(favicon.headers.get('cache-control')).toBe('no-cache')

  for (const path of ['/rpc/note/get', '/api/assets/a.png']) {
    const notPage = await get(path)
    expect(notPage.headers.get('content-type') ?? '').not.toStartWith('text/html')
    expect(notPage.ok).toBe(false)
  }
})

// 1 つの質問に添えるページの本文とスクリーンショットを受けられる上限で、それを超える body は読まずに断る。
test('a body larger than the limit for a question is refused with 413', async () => {
  const port = freePort()
  listen(port)

  const ask = (bytes: number) =>
    fetch(`http://127.0.0.1:${port}/rpc/chat/ask`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'cors',
        'content-type': 'application/json',
      },
      body: new Uint8Array(bytes),
    })

  expect((await ask(MAX_ASK_BODY_BYTES + 1)).status).toBe(413)
  // 上限の内側の壊れた body は oRPC まで届く。
  expect((await ask(1024)).status).toBe(400)
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

test('an image uploaded through the browser listener is served back byte for byte and cached for good', async () => {
  const port = freePort()
  listen(port)
  const client: ContractRouterClient<{ note: typeof contract }> = createORPCClient(
    new RPCLink({
      url: `http://127.0.0.1:${port}/rpc`,
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  )

  const { url } = await client.note.image.upload({ file: new File([PNG], 'pasted.png') })
  const image = await fetch(`http://127.0.0.1:${port}${url}`)

  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG)
})

test('a GET for an image whose name is not one the Note Ledger makes is not found, whatever is on disk', async () => {
  const port = freePort()
  const { home } = listen(port)
  const uuid = crypto.randomUUID()
  mkdirSync(join(home, 'note-images'))
  for (const name of [`${uuid.toUpperCase()}.png`, `${uuid}.svg`, `${uuid}.png.txt`, 'notes.txt']) {
    writeFileSync(join(home, 'note-images', name), PNG)
  }
  writeFileSync(join(home, 'monica.db'), 'the DB')

  for (const path of [
    `${crypto.randomUUID()}.png`,
    `${uuid.toUpperCase()}.png`,
    `${uuid}.svg`,
    `${uuid}.png.txt`,
    'notes.txt',
    '..%2Fmonica.db',
    `x/${uuid}.png`,
    '',
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/assets/${path}`)
    expect([path, response.status]).toEqual([path, 404])
    expect([path, await response.text()]).not.toEqual([path, 'the DB'])
  }
})

// headless で起こした dev の Backend が release の 19380 を取らないよう、env が無ければ既定の port にも倒さない。
test('without a port there is no browser listener', () => {
  expect(listen(undefined).listener).toBeNull()
})

// Chromium と macOS は monica.localhost を ::1 から先に引くので、::1 だけを他の process が握っていてもブラウザはそちらに繋がる。
test.each(['::1', '127.0.0.1'])(
  'a port taken on %s leaves no browser listener with one line on stderr and the other loopback free',
  (taken) => {
    const port = freePort()
    const holder = Bun.serve({ hostname: taken, port, fetch: () => new Response('someone else') })
    cleanups.push(() => void holder.stop(true))
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    cleanups.push(() => stderr.mockRestore())

    const { listener } = listen(port)

    expect(listener).toBeNull()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toContain(String(port))
    const other = taken === '::1' ? '127.0.0.1' : '::1'
    expect(() => {
      const next = Bun.serve({ hostname: other, port, fetch: () => new Response() })
      void next.stop(true)
    }).not.toThrow()
  },
)
