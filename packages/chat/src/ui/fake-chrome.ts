type FakeTab = { id: number; windowId: number; active: boolean; url?: string; title?: string }

type Listeners<F> = Set<F>
type ActivatedListener = (info: chrome.tabs.OnActivatedInfo) => void
type UpdatedListener = (
  tabId: number,
  change: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void

function event<F>(listeners: Listeners<F>) {
  return {
    addListener: (listener: F) => void listeners.add(listener),
    removeListener: (listener: F) => void listeners.delete(listener),
  }
}

/** Browser Tab で executeScript を呼んだ時に起きること。hang は返らない（view-source: など）。 */
type Reading = { html: string; selection: string } | { error: string } | 'hang'

/** Browser Tab の表示領域を captureVisibleTab で撮った時に起きること。大きさは撮った画像の px。 */
type Capture = { width: number; height: number } | { error: string } | 'hang'

/** 偽の canvas が書き出す画像の中身。本物の画像の代わりに、書き出した形式と大きさを JSON で持つ。 */
export type FakeImage = { type: string; quality?: number; width: number; height: number }

const fakeImageUrl = (image: FakeImage) =>
  `data:${image.type};base64,${btoa(JSON.stringify(image))}`

async function createImageBitmap(blob: Blob) {
  const { width, height } = JSON.parse(await blob.text()) as FakeImage
  return { width, height, close() {} }
}

class FakeOffscreenCanvas {
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext() {
    return { drawImage() {} }
  }

  async convertToBlob({ type = 'image/png', quality }: ImageEncodeOptions = {}): Promise<Blob> {
    const image: FakeImage = { type, quality, width: this.width, height: this.height }
    return new Blob([JSON.stringify(image)], { type })
  }
}

/**
 * bun test に無い chrome.tabs と chrome.scripting と、スクリーンショットを縮める createImageBitmap・OffscreenCanvas・devicePixelRatio を、
 * side panel が触る分だけ globals に置く。side panel は windowId の window に載る。
 * executeScript は注入された関数を走らせず、readings に置いた結果を返す。captureVisibleTab は screenshots に置いた大きさの偽の PNG を返す。
 */
export class FakeChrome {
  readonly tabs: FakeTab[] = []
  readonly activated: Listeners<ActivatedListener> = new Set()
  readonly updated: Listeners<UpdatedListener> = new Set()
  readonly readings = new Map<number, Reading>()
  readonly injections: unknown[] = []
  readonly screenshots = new Map<number, Capture>()
  readonly captures: unknown[][] = []
  devicePixelRatio = 1
  readonly windowId: number

  constructor(windowId: number, tabs: Omit<FakeTab, 'active'>[]) {
    this.windowId = windowId
    for (const tab of tabs) {
      const first = !this.tabs.some((other) => other.windowId === tab.windowId)
      this.tabs.push({ ...tab, active: first })
    }
  }

  install(): void {
    const query = async (filter: chrome.tabs.QueryInfo) =>
      this.tabs
        .filter((tab) => filter.active === undefined || tab.active === filter.active)
        .filter((tab) => filter.windowId === undefined || tab.windowId === filter.windowId)
        .filter((tab) => !filter.currentWindow || tab.windowId === this.windowId)
        .map((tab) => this.#asTab(tab))
    const get = async (tabId: number) => this.#asTab(this.#tab(tabId))
    const executeScript = async (injection: { target: { tabId: number } }) => {
      this.injections.push(injection)
      const reading = this.readings.get(injection.target.tabId)
      if (reading === undefined) throw new Error(`no reading for tab ${injection.target.tabId}`)
      if (reading === 'hang') return new Promise<never>(() => {})
      if ('error' in reading) throw new Error(reading.error)
      return [{ frameId: 0, documentId: 'document-0', result: reading }]
    }
    const captureVisibleTab = async (...args: unknown[]) => {
      this.captures.push(args)
      const windowId = typeof args[0] === 'number' ? args[0] : this.windowId
      const tab = this.tabs.find((each) => each.windowId === windowId && each.active)
      const capture = tab && this.screenshots.get(tab.id)
      if (capture === undefined) throw new Error(`no screenshot for window ${windowId}`)
      if (capture === 'hang') return new Promise<never>(() => {})
      if ('error' in capture) throw new Error(capture.error)
      return fakeImageUrl({ type: 'image/png', ...capture })
    }
    Object.assign(globalThis, {
      chrome: {
        tabs: {
          query,
          get,
          captureVisibleTab,
          onActivated: event(this.activated),
          onUpdated: event(this.updated),
        },
        scripting: { executeScript },
      },
      createImageBitmap,
      OffscreenCanvas: FakeOffscreenCanvas,
      devicePixelRatio: this.devicePixelRatio,
    })
  }

  uninstall(): void {
    for (const name of ['chrome', 'createImageBitmap', 'OffscreenCanvas', 'devicePixelRatio']) {
      Reflect.deleteProperty(globalThis, name)
    }
  }

  activate(tabId: number): void {
    const target = this.#tab(tabId)
    for (const tab of this.tabs) {
      if (tab.windowId === target.windowId) tab.active = tab === target
    }
    for (const listener of this.activated) listener({ tabId, windowId: target.windowId })
  }

  update(tabId: number, change: { url?: string; title?: string }): void {
    const tab = this.#tab(tabId)
    Object.assign(tab, change)
    for (const listener of this.updated) listener(tabId, change, this.#asTab(tab))
  }

  /** chrome:// のように host permission の外へ移る。onUpdated は url も title も持たずに届く。 */
  leaveForUnreadable(tabId: number): void {
    const tab = this.#tab(tabId)
    delete tab.url
    delete tab.title
    for (const listener of this.updated) listener(tabId, { status: 'loading' }, this.#asTab(tab))
  }

  #tab(tabId: number): FakeTab {
    const tab = this.tabs.find(({ id }) => id === tabId)
    if (!tab) throw new Error(`no tab ${tabId}`)
    return tab
  }

  // url と title は host permission の無いページ（chrome:// など）では無い。
  #asTab({ id, windowId, active, url, title }: FakeTab): chrome.tabs.Tab {
    return { id, windowId, active, url, title } as chrome.tabs.Tab
  }
}
