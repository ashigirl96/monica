import type { Page, Unreadable } from '../contract.ts'

// view-source:、alert() の最中、frozen のタブでは executeScript が返らない。
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

async function readWithin(tabId: number): Promise<Read | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), READ_TIMEOUT_MS)
  })
  try {
    // world は既定の ISOLATED のままにし、ページの CSP を受けない。frameIds も allFrames も渡さず、top frame だけを読む。
    const reading = chrome.scripting
      .executeScript({ target: { tabId }, func: readDocument, injectImmediately: true })
      .then(([frame]) => {
        if (!frame?.result) throw new Error('the script returned nothing')
        return frame.result
      })
    return await Promise.race([reading, timeout])
  } finally {
    clearTimeout(timer)
  }
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
async function fetchPdf(url: string, maxBytes: number): Promise<Page['content']> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal })
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
  } catch (error) {
    if (controller.signal.aborted) return fetchFailed('no response within 30 seconds')
    return fetchFailed((error as Error).message)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 送る時に取り直した Browser Tab を読む。読めなくても、質問は送れるよう理由を持った page を返す。
 * PDF は maxPdfBytes を超えたら送らずに大きすぎたことにする。
 */
export async function readPage(
  tab: chrome.tabs.Tab | undefined,
  maxPdfBytes: number,
): Promise<Page> {
  const address = {
    ...(tab?.url !== undefined && { url: tab.url }),
    ...(tab?.title !== undefined && { title: tab.title }),
  }
  if (tab?.id === undefined) {
    return {
      ...address,
      content: { kind: 'unreadable', reason: 'restricted', detail: 'no Browser Tab is active' },
    }
  }
  try {
    const read = await readWithin(tab.id)
    if (read === 'timeout')
      return { ...address, content: { kind: 'unreadable', reason: 'timeout' } }
    if (read.contentType === 'application/pdf' && tab.url !== undefined) {
      return { ...address, content: await fetchPdf(tab.url, maxPdfBytes) }
    }
    return {
      ...address,
      ...(read.selection && { selection: read.selection }),
      content: { kind: 'html', html: read.html },
    }
  } catch (error) {
    return {
      ...address,
      content: { kind: 'unreadable', reason: 'restricted', detail: (error as Error).message },
    }
  }
}
