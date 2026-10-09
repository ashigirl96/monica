import { dirname, join } from 'node:path'

import type { Page, PageSnapshot, Turn } from '../contract.ts'
import { htmlText } from './html.ts'
import { pdfText } from './pdf.ts'

/** 本文と選択範囲の上限。字は JS の文字列の length で数える。 */
export const MAX_PAGE_CHARS = 100_000

/** 先頭を残して max 字で切る。surrogate pair は割らない。 */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const last = text.charCodeAt(max - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return { text: text.slice(0, end), truncated: true }
}

/** HTML と PDF を本文にする Worker の module と、pdf.js の cMap の folder。 */
export type Readers = { htmlWorker: URL; pdfWorker: URL; cMaps: string }

/**
 * given に無いものは、packages/chat の Worker の module と、node_modules の pdfjs-dist の cMap にする。
 * compile した Backend はどれも解けないので、同梱したものを渡す。bun の isolated linker では pdfjs-dist を packages/chat からしか解けない。
 */
export function defaultReaders(given: Partial<Readers> = {}): Readers {
  return {
    htmlWorker: given.htmlWorker ?? new URL('../html-worker.ts', import.meta.url),
    pdfWorker: given.pdfWorker ?? new URL('../pdf-worker.ts', import.meta.url),
    cMaps:
      given.cMaps ??
      join(dirname(Bun.resolveSync('pdfjs-dist/package.json', import.meta.dir)), 'cmaps'),
  }
}

export type ReadOptions = { readers?: Readers; signal?: AbortSignal }

async function contentOf(
  content: Page['content'],
  url: string | undefined,
  { readers = defaultReaders(), signal }: ReadOptions,
): Promise<NonNullable<PageSnapshot['content']>> {
  if (content.kind === 'unreadable') return content
  try {
    const read =
      content.kind === 'html'
        ? await htmlText(content.html, url, readers.htmlWorker, { signal })
        : await pdfText(
            content.pdf,
            { worker: readers.pdfWorker, cMaps: readers.cMaps },
            { maxChars: MAX_PAGE_CHARS, signal },
          )
    return { kind: 'text', source: content.kind, ...cut(read, MAX_PAGE_CHARS) }
  } catch (error) {
    if (signal?.aborted) throw error
    // 本文が無くても質問には答える。
    return { kind: 'unreadable', reason: 'unparsable', detail: (error as Error).message }
  }
}

const withoutHash = (url: string) => url.split('#', 1)[0]

// 本文が一致していれば、hash だけ違う URL は同じページとみなす。
function sameTurn(url: string | undefined, text: string, history: readonly Turn[]) {
  if (url === undefined) return undefined
  const index = history.findLastIndex(
    ({ page }) =>
      page.content?.kind === 'text' &&
      page.content.text === text &&
      page.url !== undefined &&
      withoutHash(page.url) === withoutHash(url),
  )
  return index === -1 ? undefined : index
}

/**
 * side panel が送った HTML か PDF を本文にした Page Snapshot。
 * 送られた履歴に URL も本文も同じページがあれば、本文の代わりにその turn を指す。
 */
export async function snapshotOf(
  page: Page,
  history: readonly Turn[],
  options: ReadOptions = {},
): Promise<PageSnapshot> {
  const { url, title, selection, content, screenshot, screenshotFailed } = page
  const read = await contentOf(content, url, options)
  const turn = read.kind === 'text' ? sameTurn(url, read.text, history) : undefined
  return {
    ...(url !== undefined && { url }),
    ...(title !== undefined && { title }),
    ...(selection && { selection: cut(selection, MAX_PAGE_CHARS) }),
    content: turn === undefined ? read : { kind: 'same', turn },
    ...(screenshot !== undefined && { screenshot }),
    ...(screenshotFailed && { screenshotFailed }),
  }
}
