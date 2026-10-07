import { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract } from '@tania/note/contract'
import { createNoteLedger, migrations } from '@tania/note/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { listenNotes } from './notes-listener.ts'
import { freePort } from './testing.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function webDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tania-web-dist-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function listen(port: number | undefined, dist = webDist({ 'index.html': '<p>notes</p>' })) {
  const home = mkdtempSync(join(tmpdir(), 'tania-home-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home })
  const listener = listenNotes(port?.toString(), { context: { db, noteLedger }, webDist: dist })
  if (listener) cleanups.push(() => listener.stop())
  return { listener, home }
}

test('the notes listener answers on both loopbacks to the three names of its port and refuses any other Host', async () => {
  const port = freePort()
  listen(port)

  const status = async (address: string, host: string) =>
    (await fetch(`http://${address}:${port}/`, { headers: { host } })).status

  for (const address of ['127.0.0.1', '[::1]']) {
    expect(await status(address, `tania.localhost:${port}`)).toBe(200)
    expect(await status(address, `localhost:${port}`)).toBe(200)
    expect(await status(address, `127.0.0.1:${port}`)).toBe(200)
    expect(await status(address, `evil.example:${port}`)).toBe(403)
    expect(await status(address, `tania.localhost:${port + 1}`)).toBe(403)
  }
})

// 外の site からの top-level の form POST は loopback まで届く（docs/research/browser-loopback.md）。
test('a request other than GET runs a note procedure only when Sec-Fetch-Site is same-origin', async () => {
  const port = freePort()
  listen(port)

  const openDaily = (secFetchSite?: string) =>
    fetch(`http://127.0.0.1:${port}/rpc/note/daily/open`, {
      method: 'POST',
      headers: {
        host: `tania.localhost:${port}`,
        'content-type': 'application/json',
        ...(secFetchSite && { 'sec-fetch-site': secFetchSite }),
      },
      body: JSON.stringify({ json: { date: '2026-10-06' } }),
    })

  expect((await openDaily()).status).toBe(403)
  expect((await openDaily('same-site')).status).toBe(403)
  expect((await openDaily('cross-site')).status).toBe(403)
  const sameOrigin = await openDaily('same-origin')
  expect(sameOrigin.status).toBe(200)
  expect(await sameOrigin.json()).toMatchObject({ json: { kind: 'daily', date: '2026-10-06' } })
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
    fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `tania.localhost:${port}` } })

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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

test('an image uploaded through the notes listener is served back byte for byte and cached for good', async () => {
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
  writeFileSync(join(home, 'tania.db'), 'the DB')

  for (const path of [
    `${crypto.randomUUID()}.png`,
    `${uuid.toUpperCase()}.png`,
    `${uuid}.svg`,
    `${uuid}.png.txt`,
    'notes.txt',
    '..%2Ftania.db',
    `x/${uuid}.png`,
    '',
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/assets/${path}`)
    expect([path, response.status]).toEqual([path, 404])
    expect([path, await response.text()]).not.toEqual([path, 'the DB'])
  }
})

// headless で起こした dev の Backend が release の 19380 を取らないよう、env が無ければ既定の port にも倒さない。
test('without a port there is no notes listener', () => {
  expect(listen(undefined).listener).toBeNull()
})

// Chromium と macOS は tania.localhost を ::1 から先に引くので、::1 だけを他の process が握っていてもブラウザはそちらに繋がる。
test.each(['::1', '127.0.0.1'])(
  'a port taken on %s leaves notes unserved with one line on stderr and the other loopback free',
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
