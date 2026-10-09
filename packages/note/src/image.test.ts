import { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { IMAGE_URL_PREFIX } from './contract.ts'
import { idNumber } from './row.ts'
import { note } from './schema.ts'
import { createNoteLedger, migrations, router, systemJobs } from './server.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'monica-note-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home })
  cleanups.push(() => noteLedger.stop())
  const client = createRouterClient(router, { context: { db, noteLedger } })
  return { home, db, noteLedger, client, images: join(home, 'note-images') }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

const IMAGE_URL =
  /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

const nameOf = (url: string) => url.slice(IMAGE_URL_PREFIX.length)

const placedIn = (images: string) => (existsSync(images) ? readdirSync(images) : [])

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the call to fail')
}

test('an uploaded image is placed in note-images under the name its URL ends with, byte for byte', async () => {
  const { client, images } = setup()

  const { url } = await client.image.upload({ file: new File([PNG], 'pasted.png') })

  expect(url).toMatch(IMAGE_URL)
  const name = nameOf(url)
  expect(readdirSync(images)).toEqual([name])
  expect(new Uint8Array(readFileSync(join(images, name)))).toEqual(PNG)
})

// file 名と type は貼った側が決めるので、拡張子はバイト列の先頭だけから決まる。
test.each([
  ['jpg', '\xff\xd8\xff\xe0\0\x10'],
  ['gif', 'GIF87a\x01\0'],
  ['gif', 'GIF89a\x01\0'],
  ['webp', 'RIFF\x24\0\0\0WEBPVP8 '],
])('an image starting like a %s is placed as one, whatever its name says', async (ext, bytes) => {
  const { client, images } = setup()

  const { url } = await client.image.upload({
    file: new File([new Uint8Array(Buffer.from(bytes, 'latin1'))], 'pasted.png', {
      type: 'image/png',
    }),
  })

  expect(url).toEndWith(`.${ext}`)
  expect(readdirSync(images)).toEqual([nameOf(url)])
})

const MB = 1024 * 1024

function pngOf(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  bytes.set(PNG)
  return bytes
}

test('an image of 20MB is placed, and one byte more is refused as too large without placing it', async () => {
  const { client, images } = setup()

  await client.image.upload({ file: new File([pngOf(20 * MB)], 'large.png') })
  const refused = await failure(
    client.image.upload({ file: new File([pngOf(20 * MB + 1)], 'larger.png') }),
  )

  expect(refused.code).toBe('PAYLOAD_TOO_LARGE')
  expect(readdirSync(images)).toHaveLength(1)
})

test.each([
  ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['an SVG with an XML declaration', '<?xml version="1.0"?><svg/>'],
  ['text named as a png', 'not an image at all'],
  ['a RIFF that is not a webp', 'RIFF____WAVEfmt '],
  ['nothing', ''],
])('%s is refused as an unsupported image and nothing is placed', async (_, text) => {
  const { client, images } = setup()

  const refused = await failure(
    client.image.upload({ file: new File([text], 'pasted.png', { type: 'image/png' }) }),
  )

  expect(refused.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  expect(placedIn(images)).toEqual([])
})

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch })
  cleanups.push(() => void server.stop(true))
  return (path: string) => `http://127.0.0.1:${server.port}${path}`
}

test('an image on another site is fetched and placed like an uploaded one', async () => {
  const { client, images } = setup()
  const site = serve(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }))

  const { url } = await client.image.import({ url: site('/photo.png') })

  expect(url).toMatch(IMAGE_URL)
  const name = nameOf(url)
  expect(new Uint8Array(readFileSync(join(images, name)))).toEqual(PNG)
})

test('a URL that is not http or https is refused before anything is fetched', async () => {
  const { client } = setup()

  for (const url of ['file:///etc/passwd', 'data:image/png;base64,iVBORw0KGgo=', 'not a url']) {
    expect([url, (await failure(client.image.import({ url }))).code]).toEqual([url, 'BAD_REQUEST'])
  }
})

// 失敗した画像は本文に外部 URL のまま残るので、置けない応答は置かずに失敗にする。
test.each([
  ['an HTML page', 200, '<html>Not an image</html>', 'UNSUPPORTED_MEDIA_TYPE'],
  ['an image answered with 404', 404, PNG, 'BAD_GATEWAY'],
  ['a server error', 500, 'oops', 'BAD_GATEWAY'],
])('%s is not placed', async (_, status, body, code) => {
  const { client, images } = setup()
  const site = serve(() => new Response(body, { status }))

  const refused = await failure(client.image.import({ url: site('/photo.png') }))

  expect(refused.code).toBe(code)
  expect(placedIn(images)).toEqual([])
})

test('a site that cannot be reached fails as a bad gateway', async () => {
  const { client } = setup()

  const refused = await failure(client.image.import({ url: 'http://127.0.0.1:9/photo.png' }))

  expect(refused.code).toBe('BAD_GATEWAY')
})

async function until(condition: () => boolean) {
  for (let tries = 0; tries < 100 && !condition(); tries++) await Bun.sleep(10)
}

// Content-Length を持たない応答もあるので、読みながら数える。
test('an image that runs past 20MB is refused as too large, and the site stops being read', async () => {
  const { client, images } = setup()
  let sent = 0
  let cancelled = false
  const site = serve(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(sent === 0 ? pngOf(MB) : new Uint8Array(MB))
            sent += MB
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  )

  const refused = await failure(client.image.import({ url: site('/endless.png') }))

  expect(refused.code).toBe('PAYLOAD_TOO_LARGE')
  await until(() => cancelled)
  expect(cancelled).toBe(true)
  expect(sent).toBeLessThan(40 * MB)
  expect(placedIn(images)).toEqual([])
})

const never = new Promise<never>(() => {})

function captureTimeouts() {
  const timeouts: { ms: number; fire: () => void }[] = []
  const spy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController()
    timeouts.push({
      ms,
      fire: () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    })
    return controller.signal
  })
  cleanups.push(() => spy.mockRestore())
  return timeouts
}

// 画像の header が届いたことは client の側でしか分からないので、fetch の応答を待つ。
function responded(): Promise<void> {
  const realFetch = globalThis.fetch
  const { promise, resolve } = Promise.withResolvers<void>()
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    ...args: Parameters<typeof fetch>
  ) => {
    const response = await realFetch(...args)
    resolve()
    return response
  }) as typeof fetch)
  cleanups.push(() => spy.mockRestore())
  return promise
}

test.each([
  ['does not start answering', 'request', () => never],
  [
    'stops in the middle of the image',
    'response',
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(PNG)
          },
          pull: () => never,
        }),
      ),
  ],
] as const)(
  'an import from a site that %s is given up after 10 seconds',
  async (_, stage, answer) => {
    const { client, images } = setup()
    const timeouts = captureTimeouts()
    const arrived = Promise.withResolvers<void>()
    const site = serve(() => {
      arrived.resolve()
      return answer()
    })
    const fetched = responded()

    const refused = failure(client.image.import({ url: site('/slow.png') }))
    await (stage === 'request' ? arrived.promise : fetched)
    timeouts[0]!.fire()

    expect((await refused).code).toBe('GATEWAY_TIMEOUT')
    expect(timeouts.map((timeout) => timeout.ms)).toEqual([10_000])
    expect(placedIn(images)).toEqual([])
  },
)

test('stopping the Note Ledger gives up an import that is still fetching', async () => {
  const { client, noteLedger } = setup()
  const arrived = Promise.withResolvers<void>()
  const site = serve(() => {
    arrived.resolve()
    return never
  })

  const importing = failure(client.image.import({ url: site('/slow.png') }))
  await arrived.promise
  const stoppedAt = Date.now()
  noteLedger.stop()

  expect((await importing).code).toBe('BAD_GATEWAY')
  expect(Date.now() - stoppedAt).toBeLessThan(1000)
})

const HOUR = 60 * 60_000

function placeAt(images: string, name: string, hoursAgo: number) {
  mkdirSync(images, { recursive: true })
  const path = join(images, name)
  writeFileSync(path, PNG)
  const at = new Date(Date.now() - hoursAgo * HOUR)
  utimesSync(path, at, at)
  return name
}

const imageName = (ext = 'png') => `${crypto.randomUUID()}.${ext}`

function bodyWith(...blocks: object[]) {
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'blockGroup',
        content: blocks.map((b) => ({ type: 'blockContainer', content: [b] })),
      },
    ],
  }
}

const image = (src: string) => ({ type: 'image', attrs: { src, uploadId: null } })

test('cleaning removes the images no body refers to once they are older than 48 hours', async () => {
  const { client, noteLedger, images } = setup()
  const inDaily = placeAt(images, imageName(), 100)
  const inDeletedEssay = placeAt(images, imageName('webp'), 100)
  const inLink = placeAt(images, imageName('gif'), 100)
  const byAbsoluteUrl = placeAt(images, imageName(), 100)
  const old = placeAt(images, imageName('jpg'), 48.1)
  const recent = placeAt(images, imageName(), 47.9)
  const future = placeAt(images, imageName(), -100)
  const notAnImageName = [
    placeAt(images, 'notes.txt', 100),
    placeAt(images, imageName().toUpperCase().replace('.PNG', '.png'), 100),
    placeAt(images, imageName('svg'), 100),
  ]
  symlinkSync(join(images, 'gone.png'), join(images, imageName()))
  const unreadable = readdirSync(images).find((name) => !existsSync(join(images, name)))!

  const daily = await client.daily.open({ date: '2026-10-07' })
  await client.save({
    id: daily.id,
    content: bodyWith(
      image(`/api/assets/${inDaily}`),
      image(`http://monica.localhost:19380/api/assets/${byAbsoluteUrl}`),
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'see',
            marks: [{ type: 'link', attrs: { href: `/api/assets/${inLink}` } }],
          },
        ],
      },
    ),
    expectedUpdatedAt: daily.updatedAt,
  })
  const essay = await client.essay.create()
  await client.save({
    id: essay.id,
    content: bodyWith(image(`/api/assets/${inDeletedEssay}`)),
    expectedUpdatedAt: essay.updatedAt,
  })
  await client.remove({ id: essay.id })

  await noteLedger.cleanImages()

  expect(readdirSync(images).toSorted()).toEqual(
    [inDaily, inDeletedEssay, inLink, recent, future, ...notAnImageName, unreadable].toSorted(),
  )
  expect(readdirSync(images)).not.toContain(old)
  expect(readdirSync(images)).not.toContain(byAbsoluteUrl)
})

test('the system Job note.image-cleanup runs the cleaning once a day', async () => {
  const { noteLedger, images } = setup()
  const orphan = placeAt(images, imageName(), 100)

  const [job, ...others] = systemJobs(noteLedger)
  await job!.run()

  expect(others).toEqual([])
  expect(job).toMatchObject({ name: 'note.image-cleanup', every: 24 * HOUR })
  expect(placedIn(images)).not.toContain(orphan)
})

// 読めない本文の参照は数えられないので、その画像を消さないよう何も消さずに止まる。
test('cleaning a body that cannot be read removes nothing and fails', async () => {
  const { db, client, noteLedger, images } = setup()
  const orphan = placeAt(images, imageName(), 100)
  const daily = await client.daily.open({ date: '2026-10-07' })
  db.update(note)
    .set({ content: '{"type":"doc"' })
    .where(eq(note.id, idNumber(daily.id)))
    .run()

  await failure(noteLedger.cleanImages())

  expect(placedIn(images)).toEqual([orphan])
})

test('cleaning with no image ever placed does nothing', async () => {
  const { noteLedger, images } = setup()

  await noteLedger.cleanImages()

  expect(existsSync(images)).toBe(false)
})

// readdir の順は決まらないので、消せないものと消せるものを複数並べ、前後どちらにも来るようにする。
test('cleaning removes what it can and then fails naming what it could not remove', async () => {
  const { noteLedger, images } = setup()
  const stuck = [imageName(), imageName()]
  const at = new Date(Date.now() - 100 * HOUR)
  for (const name of stuck) {
    mkdirSync(join(images, name), { recursive: true })
    utimesSync(join(images, name), at, at)
  }
  for (let i = 0; i < 6; i++) placeAt(images, imageName(), 100)

  const failed = await failure(noteLedger.cleanImages())

  for (const name of stuck) expect(failed.message).toContain(name)
  expect(readdirSync(images).toSorted()).toEqual(stuck.toSorted())
})
