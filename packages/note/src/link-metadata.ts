import { ORPCError } from '@orpc/server'
import { decodeHTML, decodeHTMLAttribute } from 'entities'

import type { LinkMetadata } from './contract.ts'

const META_KEYS = ['og:title', 'og:description', 'og:image', 'og:site_name', 'description']

const TIMEOUT_MS = 10_000

export async function readLinkMetadata(url: string, stopped: AbortSignal): Promise<LinkMetadata> {
  try {
    return await readPage(url, AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), stopped]))
  } catch (error) {
    if (error instanceof ORPCError) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ORPCError('GATEWAY_TIMEOUT', {
        message: `${url} did not answer within ${TIMEOUT_MS / 1000}s`,
      })
    }
    throw new ORPCError('BAD_GATEWAY', { message: `could not read ${url}: ${error}` })
  }
}

async function readPage(url: string, signal: AbortSignal): Promise<LinkMetadata> {
  const response = await fetch(url, { signal, headers: { 'user-agent': 'tania' } })
  if (!response.ok) {
    void response.body?.cancel()
    throw new ORPCError('BAD_GATEWAY', { message: `${url} answered ${response.status}` })
  }
  const contentType = response.headers.get('content-type')
  let html = ''
  if (response.body && (contentType === null || contentType.includes('html'))) {
    html = decode(await readCapped(response.body), contentType)
  } else {
    void response.body?.cancel()
  }
  // 頁の中の相対 URL は、redirect を追った後の頁を基準に書かれている。
  return parseLinkMetadata(html, response.url)
}

// OGP は head にあるので、ここで読みやめても取りこぼさない。
const MAX_HTML_BYTES = 1024 * 1024

async function readCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_HTML_BYTES) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    chunks.push(value)
    size += value.length
  }
  void reader.cancel()
  return Buffer.concat(chunks).subarray(0, MAX_HTML_BYTES)
}

const CHARSET = /charset\s*=\s*["']?\s*([^\s"';>/]+)/i
const META_CHARSET = new RegExp(`<meta\\b[^>]*?${CHARSET.source}`, 'i')
// HTML の仕様が meta の charset を探す範囲。
const PRESCAN_BYTES = 1024

function decode(body: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(body.subarray(0, PRESCAN_BYTES))
  const label = contentType?.match(CHARSET)?.[1] ?? head.match(META_CHARSET)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(label).decode(body)
  } catch {
    return new TextDecoder().decode(body)
  }
}

function parseLinkMetadata(html: string, base: string): LinkMetadata {
  const meta = new Map<string, string>()
  let title = ''
  // svg の中の title も一致するので、最初の title だけを読む。
  let titleState: 'before' | 'inside' | 'after' = 'before'
  let iconHref: string | null = null
  new HTMLRewriter()
    .on('meta[content]', {
      element(el) {
        const content = attribute(el, 'content')?.trim()
        if (!content) return
        // OGP は property に、description は name に入る。
        for (const key of [attribute(el, 'property'), attribute(el, 'name')]) {
          if (key !== null && META_KEYS.includes(key) && !meta.has(key)) meta.set(key, content)
        }
      },
    })
    .on('title', {
      element(el) {
        if (titleState !== 'before') return
        titleState = 'inside'
        el.onEndTag(() => {
          titleState = 'after'
        })
      },
      text(chunk) {
        if (titleState === 'inside') title += chunk.text
      },
    })
    .on('link[rel][href]', {
      element(el) {
        if (iconHref !== null) return
        const rel = attribute(el, 'rel') ?? ''
        if (rel.split(/\s+/).some((token) => token.toLowerCase() === 'icon')) {
          iconHref = attribute(el, 'href')
        }
      },
    })
    .transform(html)
  const image = meta.get('og:image')
  return {
    title: meta.get('og:title') ?? (decodeHTML(title).trim() || null),
    description: meta.get('og:description') ?? meta.get('description') ?? null,
    image: image === undefined ? null : absolute(image, base),
    favicon:
      (iconHref === null ? null : absolute(iconHref, base)) ?? absolute('/favicon.ico', base),
    siteName: meta.get('og:site_name') ?? null,
  }
}

// HTMLRewriter は属性値と text の entity を decode せずに渡す。
function attribute(el: HTMLRewriterTypes.Element, name: string): string | null {
  const value = el.getAttribute(name)
  return value === null ? null : decodeHTMLAttribute(value)
}

function absolute(href: string, base: string): string | null {
  return URL.parse(href, base)?.href ?? null
}
