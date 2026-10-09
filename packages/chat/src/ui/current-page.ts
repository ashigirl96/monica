/** 見出しに出す Current Page。chrome:// などの Browser Tab では url も title も無い。 */
export type CurrentPage = { url?: string; title?: string }

export type CurrentPageWatch = {
  /** 見出しに出している Current Page。最初の tabs.query が返るまでは空。 */
  shown: () => CurrentPage
  /** side panel の window の Current Page の Browser Tab を、event を待たずに取り直す。 */
  read: () => Promise<chrome.tabs.Tab | undefined>
  /** side panel を載せた window の id。最初の tabs.query が返るまでは undefined。 */
  windowId: () => number | undefined
  stop: () => void
}

/** url と title のうち、在るものだけを持つ形。 */
export function addressOf({ url, title }: CurrentPage): CurrentPage {
  return { ...(url !== undefined && { url }), ...(title !== undefined && { title }) }
}

/** side panel を載せた window の Current Page を追い、変わるたびに onChange を呼ぶ。 */
export function watchCurrentPage(onChange: (page: CurrentPage) => void): CurrentPageWatch {
  let windowId: number | undefined
  let tabId: number | undefined
  let shown: CurrentPage | undefined
  let stopped = false

  const show = (tab: chrome.tabs.Tab) => {
    tabId = tab.id
    shown = addressOf(tab)
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
    shown: () => shown ?? {},
    async read() {
      const [tab] = await chrome.tabs.query(
        windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId },
      )
      return tab
    },
    windowId: () => windowId,
    stop() {
      stopped = true
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    },
  }
}
