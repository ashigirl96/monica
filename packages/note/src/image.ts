import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { ORPCError } from '@orpc/server'

import { imageReferences } from './body/index.ts'
import { IMAGE_URL_PREFIX } from './contract.ts'
import type { Db } from './note.ts'
import { note } from './schema.ts'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// 置いた画像が本文に保存される前に消さないための猶予。
const CLEAN_GRACE_MS = 48 * 60 * 60_000

// この形の file だけを消して配るので、置き場所に別の file があっても触れない。
const IMAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/

const tooLarge = () => new ORPCError('PAYLOAD_TOO_LARGE', { message: 'an image is up to 20MB' })

// 本文の中で script を動かせるので、SVG は magic bytes を持たないまま断られる。
function extensionOf(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 12)).toString('latin1')
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'png'
  if (head.startsWith('\xff\xd8\xff')) return 'jpg'
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif'
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'webp'
  return null
}

/** 再 encode せずに書くので、動く GIF も動いたまま残る。 */
export async function placeImage(dir: string, bytes: Uint8Array): Promise<{ url: string }> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw tooLarge()
  const ext = extensionOf(bytes)
  if (!ext) {
    throw new ORPCError('UNSUPPORTED_MEDIA_TYPE', {
      message: 'an image is a png, jpg, gif or webp',
    })
  }
  const name = `${crypto.randomUUID()}.${ext}`
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, name), bytes)
  return { url: `${IMAGE_URL_PREFIX}${name}` }
}

export const IMPORT_TIMEOUT_MS = 10_000

export type ImageDeps = { dir: string; stopped: AbortSignal }

export async function importImage(
  deps: ImageDeps,
  url: string,
  timeoutMs: number,
): Promise<{ url: string }> {
  let bytes: Uint8Array
  try {
    bytes = await fetchImage(url, AbortSignal.any([AbortSignal.timeout(timeoutMs), deps.stopped]))
  } catch (error) {
    if (error instanceof ORPCError) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ORPCError('GATEWAY_TIMEOUT', {
        message: `the image did not arrive within ${timeoutMs / 1000}s`,
      })
    }
    throw new ORPCError('BAD_GATEWAY', { message: `could not fetch the image: ${error}` })
  }
  return placeImage(deps.dir, bytes)
}

async function fetchImage(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new ORPCError('BAD_GATEWAY', {
      message: `the image was answered with ${response.status}`,
    })
  }
  const chunks: Uint8Array[] = []
  let size = 0
  // for await を throw で抜けると body が cancel され、相手への接続も切れる。
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_IMAGE_BYTES) throw tooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function serveImage(dir: string, name: string): Promise<Response> {
  // 名前を照合してから path にするので、`..` や別の directory には届かない。
  const file = IMAGE_NAME.test(name) ? Bun.file(join(dir, name)) : null
  if (!file || !(await file.exists())) return new Response('Not Found', { status: 404 })
  // 同じ名前の画像は中身が変わらない。
  return new Response(file, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
}

// 同期の fs で走らせ、参照を読んでから消すまでの間に、save が古い画像の参照を書き戻す隙を作らない。
export async function cleanImages(db: Db, dir: string): Promise<void> {
  // 削除した Note も取り消せるので、その本文の参照も数える。
  const referenced = new Set(
    db
      .select({ content: note.content })
      .from(note)
      .all()
      .flatMap(({ content }) => imageReferences(JSON.parse(content))),
  )
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const now = Date.now()
  const failures: string[] = []
  for (const name of names) {
    if (!IMAGE_NAME.test(name) || referenced.has(name)) continue
    const path = join(dir, name)
    // mtime が読めないものと未来のものは、いつ置いたか分からないので残す。
    let placedAt: number
    try {
      placedAt = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (now - placedAt <= CLEAN_GRACE_MS) continue
    try {
      unlinkSync(path)
    } catch (error) {
      failures.push(`${name} (${(error as Error).message})`)
    }
  }
  if (failures.length > 0) throw new Error(`could not remove ${failures.join(', ')}`)
}
