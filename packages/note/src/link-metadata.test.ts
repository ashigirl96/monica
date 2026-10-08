import { Database } from 'bun:sqlite'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { type FakeSite, startFakeSite } from './fake-site.ts'
import { createNoteLedger, migrations, router } from './server.ts'

const sites: FakeSite[] = []

afterEach(() => {
  mock.restore()
  for (const site of sites.splice(0)) void site.stop()
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the call to fail')
}

async function until(done: () => boolean, withinMs = 2000) {
  const deadline = Date.now() + withinMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${withinMs}ms`)
    await Bun.sleep(1)
  }
}

function setup() {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home: tmpdir() })
  const client = createRouterClient(router, { context: { db, noteLedger } })
  const site = startFakeSite()
  sites.push(site)
  return { client, noteLedger, site }
}

type Client = ReturnType<typeof setup>['client']

test('the OGP of a page is read, its relative URLs resolved against the page the redirects end at', async () => {
  const { client, site } = setup()
  site.page('/old', { status: 301, headers: { location: '/watch/abc' } })
  site.page('/watch/abc', {
    body: `<html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Bonobo - Dark Will Fall">
      <meta property="og:description" content="From the LAZARUS soundtrack.">
      <meta property="og:image" content="thumbs/abc.jpg">
      <meta property="og:site_name" content="YouTube">
      <link rel="shortcut icon" href="/favicon.png">
    </head><body></body></html>`,
  })

  expect(await client.linkMetadata({ url: site.url('/old') })).toEqual({
    title: 'Bonobo - Dark Will Fall',
    description: 'From the LAZARUS soundtrack.',
    image: site.url('/watch/thumbs/abc.jpg'),
    favicon: site.url('/favicon.png'),
    siteName: 'YouTube',
  })
})

test('without OGP, the title comes from the first <title>, the description from meta name=description, and the favicon from /favicon.ico', async () => {
  const { client, site } = setup()
  site.page('/plain', {
    body: `<html><head>
      <title>  Plain Page  </title>
      <meta property="og:title" content="   ">
      <meta name="description" content="A page without OGP.">
      <meta name="description" content="A second description.">
      <link rel="apple-touch-icon" href="/touch.png">
    </head><body><svg><title>An icon</title></svg></body></html>`,
  })

  expect(await client.linkMetadata({ url: site.url('/plain') })).toEqual({
    title: 'Plain Page',
    description: 'A page without OGP.',
    image: null,
    favicon: site.url('/favicon.ico'),
    siteName: null,
  })
})

test('entities in the title, the meta and the URLs are decoded, those in an attribute by the rules for attributes', async () => {
  const { client, site } = setup()
  site.page('/entities', {
    body: `<html><head>
      <title>Tom &amp; Jerry &mdash; &#x41;&#66;</title>
      <meta property="og:description" content="&quot;Quoted&quot; &hellip;">
      <meta property="og:image" content="/img?w=1&amp;h=2&copy=3">
      <meta property="og:site_name" content="Caf&eacute;">
      <link rel="icon" href="/icon?v=1&amp;s=32">
    </head></html>`,
  })

  expect(await client.linkMetadata({ url: site.url('/entities') })).toEqual({
    title: 'Tom & Jerry — AB',
    description: '"Quoted" …',
    image: site.url('/img?w=1&h=2&copy=3'),
    favicon: site.url('/icon?v=1&s=32'),
    siteName: 'Café',
  })
})

// iconv -f UTF-8 -t SHIFT_JIS で作った byte 列。
const SJIS_TITLE = Buffer.from('93fa967b8cea82cc95c5', 'hex') // 日本語の頁
const SJIS_DESCRIPTION = Buffer.from('835c815b8358', 'hex') // ソース

function sjisPage(head: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(`<html><head>${head}<title>`),
    SJIS_TITLE,
    Buffer.from('</title><meta property="og:description" content="'),
    SJIS_DESCRIPTION,
    Buffer.from('"></head></html>'),
  ])
}

test('a Shift_JIS page is decoded by the charset in its Content-Type, or else in its meta', async () => {
  const { client, site } = setup()
  const sjis = { 'content-type': 'text/html; charset=Shift_JIS' }
  site.page('/header', { headers: sjis, body: sjisPage('') })
  site.page('/header-over-meta', { headers: sjis, body: sjisPage('<meta charset="utf-8">') })
  site.page('/meta-charset', { body: sjisPage('<meta charset="shift_jis">') })
  site.page('/meta-http-equiv', {
    body: sjisPage('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'),
  })

  for (const path of ['/header', '/header-over-meta', '/meta-charset', '/meta-http-equiv']) {
    expect(await client.linkMetadata({ url: site.url(path) })).toMatchObject({
      title: '日本語の頁',
      description: 'ソース',
    })
  }
})

test('a page with no charset, one TextDecoder does not know, or charset= only in a meta not declaring one, is read as UTF-8', async () => {
  const { client, site } = setup()
  site.page('/none', { body: '<title>日本語</title>' })
  site.page('/unknown', {
    headers: { 'content-type': 'text/html; charset=x-no-such-charset' },
    body: '<title>日本語</title>',
  })
  site.page('/unrelated-meta', {
    body: `<html><head>
      <meta name="description" content="Pages in charset=Shift_JIS">
      <meta http-equiv="refresh" content="0; url=/next?charset=shift_jis">
      <title>日本語</title>
    </head></html>`,
  })

  for (const path of ['/none', '/unknown', '/unrelated-meta']) {
    expect(await client.linkMetadata({ url: site.url(path) })).toMatchObject({ title: '日本語' })
  }
})

test('the page is asked for with monica as the User-Agent', async () => {
  const { client, site } = setup()
  site.page('/page', { body: '<title>Page</title>' })

  await client.linkMetadata({ url: site.url('/page') })

  expect(site.requests).toEqual([{ path: '/page', userAgent: 'monica' }])
})

test('a page answered with a status other than 2xx fails, even with a title in it', async () => {
  const { client, site } = setup()
  const body = '<html><head><title>Page not found</title></head></html>'
  site.page('/missing', { status: 404, body })
  site.page('/down', { status: 503, body })
  site.page('/moved', { status: 302, headers: { location: '/missing' } })

  for (const path of ['/missing', '/down', '/moved']) {
    const error = await failure(client.linkMetadata({ url: site.url(path) }))

    expect(error.code).toBe('BAD_GATEWAY')
  }
})

test('the body of a page whose Content-Type is not HTML is not read, and one with no Content-Type or HTML in any case is', async () => {
  const { client, site } = setup()
  const body = '<html><head><title>Read</title></head></html>'
  site.page('/image.png', { headers: { 'content-type': 'image/png' }, body })
  site.page('/untyped', { headers: {}, body })
  site.page('/upper-case', { headers: { 'content-type': 'Text/HTML; Charset=UTF-8' }, body })

  expect(await client.linkMetadata({ url: site.url('/image.png') })).toEqual({
    title: null,
    description: null,
    image: null,
    favicon: site.url('/favicon.ico'),
    siteName: null,
  })
  for (const path of ['/untyped', '/upper-case']) {
    expect(await client.linkMetadata({ url: site.url(path) })).toMatchObject({ title: 'Read' })
  }
})

test('a page is read up to 1MB, and the rest of an endless body is not asked for', async () => {
  const { client, site } = setup()
  const head = '<html><head><title>Big</title>'
  const withinCap = '<meta property="og:description" content="Within the cap">'
  const pastCap = '<meta property="og:site_name" content="Past the cap">'
  const padding = ' '.repeat(1024 * 1024 - head.length - withinCap.length)
  site.page('/endless', { body: head + padding + withinCap + pastCap, rest: 'endless' })

  expect(await client.linkMetadata({ url: site.url('/endless') })).toMatchObject({
    title: 'Big',
    description: 'Within the cap',
    siteName: null,
  })
  // 読みやめたまま捨てた body も、1 秒ほどで GC が cancel するので、それより早く届くことを見る。
  await until(() => site.cancelled.includes('/endless'), 200)
})

function captureTimeouts() {
  const timeouts: { ms: number; fire: () => void }[] = []
  spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController()
    timeouts.push({
      ms,
      fire: () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    })
    return controller.signal
  })
  return timeouts
}

async function inFlight(client: Client, site: FakeSite, path: string) {
  const call = failure(client.linkMetadata({ url: site.url(path) }))
  await until(() => site.requests.some((request) => request.path === path))
  // 止まった body を読んでいるところで打ち切るため、header が client に届くのを待つ。
  await Bun.sleep(50)
  return { failed: call }
}

test('a page that does not send its header fails after 10 seconds', async () => {
  const { client, site } = setup()
  const timeouts = captureTimeouts()
  site.page('/late', { body: '<title>Late</title>' })
  site.hold()

  const { failed } = await inFlight(client, site, '/late')
  timeouts[0]!.fire()

  expect((await failed).code).toBe('GATEWAY_TIMEOUT')
  expect(timeouts.map((timeout) => timeout.ms)).toEqual([10_000])
})

test('a page that stops in the middle of its body fails after 10 seconds', async () => {
  const { client, site } = setup()
  const timeouts = captureTimeouts()
  site.page('/stalled', { body: '<html><head><title>Slow', rest: 'stalled' })

  const { failed } = await inFlight(client, site, '/stalled')
  timeouts[0]!.fire()

  expect((await failed).code).toBe('GATEWAY_TIMEOUT')
  expect(timeouts.map((timeout) => timeout.ms)).toEqual([10_000])
})

test('a URL that is not http or https is refused', async () => {
  const { client } = setup()

  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<title>x</title>',
    'ftp://example.com/',
    'not a url',
  ]) {
    expect((await failure(client.linkMetadata({ url }))).code).toBe('BAD_REQUEST')
  }
})

test('a page that redirects to a local file fails without reading it', async () => {
  const { client, site } = setup()
  const file = join(await mkdtemp(join(tmpdir(), 'monica-ogp-')), 'secret.html')
  await writeFile(file, '<title>Secret</title>')
  site.page('/to-file', { status: 302, headers: { location: `file://${file}` } })

  expect((await failure(client.linkMetadata({ url: site.url('/to-file') }))).code).toBe(
    'BAD_GATEWAY',
  )
})

test('stopping the Note Ledger stops a fetch waiting for the header', async () => {
  const { client, noteLedger, site } = setup()
  site.page('/late', { body: '<title>Late</title>' })
  site.hold()

  const { failed } = await inFlight(client, site, '/late')
  noteLedger.stop()

  expect((await failed).code).toBe('BAD_GATEWAY')
})

test('stopping the Note Ledger stops a fetch in the middle of the body', async () => {
  const { client, noteLedger, site } = setup()
  site.page('/stalled', { body: '<html><head><title>Slow', rest: 'stalled' })

  const { failed } = await inFlight(client, site, '/stalled')
  noteLedger.stop()

  expect((await failed).code).toBe('BAD_GATEWAY')
})

test('the first link whose rel has icon in any case and whose href resolves gives the favicon', async () => {
  const { client, site } = setup()
  site.page('/icons', {
    body: `<html><head>
      <link rel="stylesheet" href="/style.css">
      <link rel="icon" href="">
      <link rel="icon" href="   ">
      <link rel="icon" href="http://[not-a-host">
      <link rel="ICON" href="/first.ico">
      <link rel="icon" href="/second.ico">
    </head></html>`,
  })

  expect(await client.linkMetadata({ url: site.url('/icons') })).toMatchObject({
    title: null,
    favicon: site.url('/first.ico'),
  })
})
