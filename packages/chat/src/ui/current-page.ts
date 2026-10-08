import type { Page } from '../contract.ts'

export type CurrentPageWatch = {
  /** side panel の window の Current Page を、event を待たずに取り直す。 */
  read: () => Promise<Page>
  stop: () => void
}

function pageOf({ url, title }: chrome.tabs.Tab): Page {
  return { ...(url !== undefined && { url }), ...(title !== undefined && { title }) }
}

/** side panel を載せた window の Current Page を追い、変わるたびに onChange を呼ぶ。 */
export function watchCurrentPage(onChange: (page: Page) => void): CurrentPageWatch {
  let windowId: number | undefined
  let tabId: number | undefined
  let shown: Page | undefined
  let stopped = false

  const show = (tab: chrome.tabs.Tab) => {
    tabId = tab.id
    shown = pageOf(tab)
    onChange(shown)
  }
  const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
    if (info.windowId !== windowId) return
    tabId = info.tabId
    void chrome.tabs.get(info.tabId).then((tab) => {
      if (!stopped && tab.id === tabId) show(tab)
    })
  }
  // pushState と hash の変更も url の変化として届く。chrome:// へ移ったときは url も title も無い event だけが届くので、
  // 変化の中身ではなく tab の url と title を前に出したものと比べる。
  const onUpdated = (id: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
    if (id !== tabId || (tab.url === shown?.url && tab.title === shown?.title)) return
    show(tab)
  }

  chrome.tabs.onActivated.addListener(onActivated)
  chrome.tabs.onUpdated.addListener(onUpdated)
  // side panel の page からは、別の window に focus があっても、side panel を載せた window の Browser Tab が返る。
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (stopped || !tab) return
    windowId = tab.windowId
    show(tab)
  })

  return {
    async read() {
      const [tab] = await chrome.tabs.query(
        windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId },
      )
      return tab ? pageOf(tab) : {}
    },
    stop() {
      stopped = true
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    },
  }
}
