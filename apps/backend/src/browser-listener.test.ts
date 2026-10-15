import { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { contract } from '@monica/note/contract'
import { createNoteLedger, migrations, router as noteRouter } from '@monica/note/server'
import {
  createUsageLedger,
  featuresOf,
  migrations as usageMigrations,
  router as usageRouter,
} from '@monica/usage/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { browserRouter, listenBrowser } from './browser-listener.ts'
import { freePort } from './testing.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
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
  for (const m of [migrations, usageMigrations]) {
    migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
  }
  const noteLedger = createNoteLedger({ db, home })
  const usageLedger = createUsageLedger({ db, features: featuresOf(browserRouter) })
  const listener = listenBrowser(port?.toString(), {
    context: { db, noteLedger },
    usageLedger,
    webDist: dist,
  })
  if (listener) cleanups.push(() => listener.stop())
  const usages = async () =>
    (await createRouterClient(usageRouter, { context: { db, usageLedger } }).list()).usages
  const notes = createRouterClient(noteRouter, { context: { db, noteLedger } })
  return { listener, home, usages, notes }
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

test('a note procedure called through the browser listener counts as Usage by notes', async () => {
  const port = freePort()
  const { usages } = listen(port)

  const response = await fetch(`http://127.0.0.1:${port}/rpc/note/daily/open`, {
    method: 'POST',
    headers: {
      host: `monica.localhost:${port}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ json: { date: '2026-10-06' } }),
  })

  expect(response.status).toBe(200)
  expect(await usages()).toContainEqual(
    expect.objectContaining({ feature: 'note.daily.open', caller: 'notes', ok: 1, failed: 0 }),
  )
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

function paragraph(text: string) {
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'blockContainer',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    ],
  }
}

// SPA はどの route にも同じ index.html を返すので、Note の URL を貼った bookmark が Note の名前で出るよう頁に OGP を足す。
test('the page of a Note carries its name and preview as OGP, so a pasted Note URL reads as that Note', async () => {
  const dist = webDist({
    'index.html': '<html><head><title>monica</title></head><body></body></html>',
  })
  const port = freePort()
  const { notes } = listen(port, dist)
  const write = async (id: string, text: string, title?: string) => {
    const { updatedAt } = await notes.get({ id })
    await notes.save({ id, content: paragraph(text), title, expectedUpdatedAt: updatedAt })
  }
  const repoNote = await notes.repoNote.create({ repo: 'ashigirl96/monica' })
  await write(repoNote.id, 'the body <&> "quoted"', 'Plan & "notes"')
  const essay = await notes.essay.create()
  await write(essay.id, 'an essay', 'Essay')
  const removed = await notes.essay.create()
  await write(removed.id, 'gone', 'Removed')
  await notes.remove({ id: removed.id })
  const scratch = await notes.scratch.open({ repo: 'ashigirl96/monica' })
  await write(scratch.id, 'scratch')

  const cases: [path: string, title: string, description: string | null][] = [
    [`/repos/ashigirl96/monica/notes/${repoNote.id}`, 'Plan & "notes"', 'the body <&> "quoted"'],
    [`/notes/${repoNote.id}`, 'Plan & "notes"', 'the body <&> "quoted"'],
    [`/essays/${essay.id}`, 'Essay', 'an essay'],
    ['/repos/ashigirl96/monica', 'ashigirl96/monica', 'scratch'],
    [`/essays/${removed.id}`, 'monica', null],
    ['/essays/note-999', 'monica', null],
    ['/daily/2026-10-06', 'monica', null],
  ]
  for (const [path, title, description] of cases) {
    const read = await notes.linkMetadata({ url: `http://127.0.0.1:${port}${path}` })
    expect([path, read.title, read.description]).toEqual([path, title, description])
  }
  // 頁を読むだけで、開くと作られる Daily を作らない。
  expect(await notes.daily.dates()).toEqual([])
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

test('a GET from another site runs no note procedure', async () => {
  const port = freePort()
  const { notes } = listen(port)
  const data = encodeURIComponent(JSON.stringify({ json: { date: '2026-10-06' } }))

  const response = await fetch(`http://127.0.0.1:${port}/rpc/note/daily/open?data=${data}`, {
    headers: { host: `monica.localhost:${port}`, 'sec-fetch-site': 'cross-site' },
  })

  expect(response.status).not.toBe(200)
  expect(await notes.daily.dates()).toEqual([])
})

test('the browser listener lets no page of another origin read its answers', async () => {
  const port = freePort()
  listen(port)
  const headers = {
    host: `monica.localhost:${port}`,
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  }

  const page = await fetch(`http://127.0.0.1:${port}/`, { headers })
  const preflight = await fetch(`http://127.0.0.1:${port}/rpc/note/daily/open`, {
    method: 'OPTIONS',
    headers: { ...headers, 'access-control-request-method': 'POST' },
  })

  expect(page.headers.get('access-control-allow-origin')).toBeNull()
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
})

test('a GET serves only the files the build output had when the listener started', async () => {
  const dist = webDist({ 'index.html': '<p>notes</p>' })
  const port = freePort()
  listen(port, dist)
  writeFileSync(join(dist, 'late.txt'), 'late')

  const late = await fetch(`http://127.0.0.1:${port}/late.txt`, {
    headers: { host: `monica.localhost:${port}` },
  })

  expect(await late.text()).toBe('<p>notes</p>')
})

test('an image of 20MB goes through the browser listener to the Note Ledger', async () => {
  const port = freePort()
  listen(port)
  const client: ContractRouterClient<{ note: typeof contract }> = createORPCClient(
    new RPCLink({
      url: `http://127.0.0.1:${port}/rpc`,
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  )
  const png = new Uint8Array(20 * 1024 * 1024)
  png.set(PNG)

  const { url } = await client.note.image.upload({ file: new File([png], 'large.png') })

  expect((await fetch(`http://127.0.0.1:${port}${url}`)).status).toBe(200)
})

test('a browser listener without the built notes screens answers a GET for a page with 404', async () => {
  const port = freePort()
  listen(port, join(tmpdir(), `monica-no-web-dist-${crypto.randomUUID()}`))

  const page = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { host: `monica.localhost:${port}` },
  })

  expect(page.status).toBe(404)
  expect(page.headers.get('content-type') ?? '').not.toStartWith('text/html')
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
