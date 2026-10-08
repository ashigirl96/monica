import type { Page } from '../contract.ts'

// view-source:、alert() の最中、frozen のタブでは executeScript が返らない。
const READ_TIMEOUT_MS = 3000

type Read = { html: string; selection: string }

/**
 * Browser Tab の中で走らせる関数。executeScript は func を文字列にして送るので、外の変数も helper も参照しない。
 * shadow root は closed のものまで集め、getHTML で <template shadowrootmode> にして書き出す。
 */
function readDocument(): Read {
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
  return { html: document.documentElement.getHTML({ shadowRoots: roots }), selection }
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

/** 送る時に取り直した Browser Tab を読む。読めなくても、質問は送れるよう理由を持った page を返す。 */
export async function readPage(tab: chrome.tabs.Tab | undefined): Promise<Page> {
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
