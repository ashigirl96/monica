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

/**
 * bun test に無い chrome.tabs と chrome.scripting を、side panel が触る分だけ globals に置く。side panel は windowId の window に載る。
 * executeScript は注入された関数を走らせず、readings に置いた結果を返す。
 */
export class FakeChrome {
  readonly tabs: FakeTab[] = []
  readonly activated: Listeners<ActivatedListener> = new Set()
  readonly updated: Listeners<UpdatedListener> = new Set()
  readonly readings = new Map<number, Reading>()
  readonly injections: unknown[] = []
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
    Object.assign(globalThis, {
      chrome: {
        tabs: { query, get, onActivated: event(this.activated), onUpdated: event(this.updated) },
        scripting: { executeScript },
      },
    })
  }

  uninstall(): void {
    Reflect.deleteProperty(globalThis, 'chrome')
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
