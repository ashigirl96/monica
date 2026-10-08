import type { Page, PageSnapshot, Turn } from '../contract.ts'
import { pageText } from './extract.ts'

/** 本文と選択範囲の上限。字は JS の文字列の length で数える。 */
export const MAX_PAGE_CHARS = 100_000

/** 先頭を残して max 字で切る。surrogate pair は割らない。 */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const last = text.charCodeAt(max - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return { text: text.slice(0, end), truncated: true }
}

async function contentOf(
  content: Page['content'],
  url: string | undefined,
): Promise<NonNullable<PageSnapshot['content']>> {
  if (content.kind === 'unreadable') return content
  try {
    const { text, truncated } = cut(await pageText(content.html, url), MAX_PAGE_CHARS)
    return { kind: 'text', text, truncated }
  } catch (error) {
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
 * side panel が送った HTML を本文にした Page Snapshot。
 * 送られた履歴に URL も本文も同じページがあれば、本文の代わりにその turn を指す。
 */
export async function snapshotOf(page: Page, history: readonly Turn[]): Promise<PageSnapshot> {
  const { url, title, selection, content } = page
  const read = await contentOf(content, url)
  const turn = read.kind === 'text' ? sameTurn(url, read.text, history) : undefined
  return {
    ...(url !== undefined && { url }),
    ...(title !== undefined && { title }),
    ...(selection && { selection: cut(selection, MAX_PAGE_CHARS) }),
    content: turn === undefined ? read : { kind: 'same', turn },
  }
}
