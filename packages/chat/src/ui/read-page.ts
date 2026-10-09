import type { Page, Unreadable } from '../contract.ts'
import { addressOf } from './current-page.ts'
import { messageOf } from './failure.ts'
import { unlessAborted, within } from './within.ts'

// view-source:、alert() の最中、frozen の Browser Tab では executeScript が返らない。
const READ_TIMEOUT_MS = 3000
const FETCH_TIMEOUT_MS = 30_000

type Read = { contentType: string; html: string; selection: string }

/**
 * Browser Tab の中で走らせる関数。executeScript は func を文字列にして送るので、外の変数も helper も参照しない。
 * shadow root は closed のものまで集め、getHTML で <template shadowrootmode> にして書き出す。
 */
function readDocument(): Read {
  // PDF viewer の DOM は空で、viewer の frame には注入できず、その中の選択範囲も top frame からは読めない。
  if (document.contentType === 'application/pdf') {
    return { contentType: document.contentType, html: '', selection: '' }
  }
  const roots: ShadowRoot[] = []
  const pending: Element[] = [document.documentElement]
  for (let element = pending.pop(); element; element = pending.pop()) {
    const root = element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null
    if (root) {
      roots.push(root)
      for (const child of root.children) pending.push(child)
    }
    for (const child of element.children) pending.push(child)
  }
  // textarea と input の selectionStart/End は別の場所を選んだ後も残るので、focus のある欄だけを読む。password の中は読まない。
  const active = document.activeElement
  const field =
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && ['text', 'search', 'url', 'tel'].includes(active.type))
      ? active
      : undefined
  const selection = field
    ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
    : active instanceof HTMLInputElement
      ? ''
      : (getSelection()?.toString() ?? '')
  return {
    contentType: document.contentType,
    html: document.documentElement.getHTML({ shadowRoots: roots }),
    selection,
  }
}

function readWithin(tabId: number): Promise<Read | 'timeout'> {
  // world は既定の ISOLATED のままにし、ページの CSP を受けない。frameIds も allFrames も渡さず、top frame だけを読む。
  const reading = chrome.scripting
    .executeScript({ target: { tabId }, func: readDocument, injectImmediately: true })
    .then(([frame]) => {
      if (!frame?.result) throw new Error('the script returned nothing')
      return frame.result
    })
  return within(reading, READ_TIMEOUT_MS)
}

const PDF_MAGIC = '%PDF-'

const fetchFailed = (detail: string): Unreadable => ({
  kind: 'unreadable',
  reason: 'fetch-failed',
  detail,
})

/** body を maxBytes まで読む。超えたら読むのをやめて undefined を返す。 */
async function bodyWithin(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body?.getReader()
  if (!reader) return new Blob([])
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return new Blob(chunks)
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
}

/**
 * PDF viewer の DOM は空なので、Browser Tab の URL を fetch する。host_permissions の host には CORS を受けない。
 * cookie を付けるのは、ログインが要る PDF も取れる見込みがあるため（確かめていない）。
 */
async function pdfOf(url: string, maxBytes: number, signal: AbortSignal): Promise<Page['content']> {
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) {
    await response.body?.cancel()
    return fetchFailed(`HTTP ${response.status}`)
  }
  const body = await bodyWithin(response, maxBytes)
  if (!body) return { kind: 'unreadable', reason: 'too-large' }
  // ログインが要る PDF は、ログインのページの HTML が 200 で返りうる。
  if ((await body.slice(0, PDF_MAGIC.length).text()) !== PDF_MAGIC) {
    return fetchFailed('the response is not a PDF')
  }
  return { kind: 'pdf', pdf: new File([body], 'page.pdf', { type: 'application/pdf' }) }
}

/** body を読み終えるまでを 30 秒で打ち切る。signal が abort したら、fetch を止めて reject する。 */
async function fetchPdf(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Page['content']> {
  const controller = new AbortController()
  const stop = () => controller.abort(signal.reason)
  signal.addEventListener('abort', stop)
  try {
    const fetched = await within(
      unlessAborted(pdfOf(url, maxBytes, controller.signal), signal),
      FETCH_TIMEOUT_MS,
    )
    return fetched === 'timeout' ? fetchFailed('no response within 30 seconds') : fetched
  } catch (error) {
    if (signal.aborted) throw error
    return fetchFailed(messageOf(error))
  } finally {
    signal.removeEventListener('abort', stop)
    // 打ち切った fetch の body を読み続けない。
    controller.abort()
  }
}

const restricted = (detail: string): Unreadable => ({
  kind: 'unreadable',
  reason: 'restricted',
  detail,
})

/**
 * 送る時に取り直した Browser Tab を読む。読めなくても、質問は送れるよう理由を持った page を返す。
 * PDF は maxPdfBytes を超えたら送らずに大きすぎたことにする。signal が abort したら、PDF の fetch を止めて reject する。
 */
export async function readPage(
  tab: chrome.tabs.Tab | undefined,
  { maxPdfBytes, signal }: { maxPdfBytes: number; signal: AbortSignal },
): Promise<Page> {
  const address = addressOf(tab ?? {})
  if (tab?.id === undefined) return { ...address, content: restricted('no Browser Tab is active') }
  let read: Read | 'timeout'
  try {
    read = await readWithin(tab.id)
  } catch (error) {
    return { ...address, content: restricted(messageOf(error)) }
  }
  if (read === 'timeout') return { ...address, content: { kind: 'unreadable', reason: 'timeout' } }
  if (read.contentType === 'application/pdf' && tab.url !== undefined) {
    return { ...address, content: await fetchPdf(tab.url, maxPdfBytes, signal) }
  }
  return {
    ...address,
    ...(read.selection && { selection: read.selection }),
    content: { kind: 'html', html: read.html },
  }
}
