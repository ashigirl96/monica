import type { RunButton } from '@monica/task/contract'

import type { RunButtonRequest, RunButtonsReply, RunFromButtonReply } from './run-button-relay.ts'

// repo の画面すべてに注入され、GitHub は画面を client 側で移るので、一覧かは走査のたびに URL で見る。
const ISSUES_LIST = /^\/([^/]+)\/([^/]+)\/issues\/?$/
const TITLE_LINK = 'a[data-testid="issue-listitem-title-link"]'

const buttons = new WeakMap<HTMLAnchorElement, HTMLElement>()

const LABELS: Record<RunButton['run'], string> = { new: 'Run', resume: '再開', running: '実行中' }

function listedRepo(): string | null {
  const [, owner, name] = ISSUES_LIST.exec(location.pathname) ?? []
  return owner && name ? `${owner}/${name}` : null
}

function refOf(link: HTMLAnchorElement, repo: string): string | null {
  const url = new URL(link.href, location.href)
  const [, owner, name, number] = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url.pathname) ?? []
  if (url.origin !== location.origin || `${owner}/${name}`.toLowerCase() !== repo.toLowerCase())
    return null
  return `${owner}/${name}#${number}`
}

async function send<T>(request: RunButtonRequest): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as T
  } catch {
    // Chrome Extension の reload の後は、古い content script から service worker に届かない。
    return null
  }
}

async function scan() {
  const repo = listedRepo()
  if (!repo) return
  const asked = new Map<string, HTMLAnchorElement[]>()
  for (const link of document.querySelectorAll<HTMLAnchorElement>(TITLE_LINK)) {
    const ref = refOf(link, repo)
    // GitHub が行の要素を使い回して別の Issue を描いたら、前のボタンを外して決め直す。
    if (!ref || link.dataset.monicaRef === ref) continue
    buttons.get(link)?.remove()
    link.dataset.monicaRef = ref
    asked.set(ref, [...(asked.get(ref) ?? []), link])
  }
  if (asked.size === 0) return
  const reply = await send<RunButtonsReply>({ type: 'monica.runButtons', refs: [...asked.keys()] })
  for (const { ref, button } of reply?.buttons ?? []) {
    if (!button) continue
    for (const link of asked.get(ref) ?? []) {
      if (link.dataset.monicaRef !== ref || !link.isConnected) continue
      const runButton = runButtonFor(ref, button.run)
      buttons.set(link, runButton)
      link.after(runButton)
    }
  }
}

function runButtonFor(ref: string, run: RunButton['run']): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:8px'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-sm'
  button.textContent = LABELS[run]
  button.disabled = run === 'running'
  button.dataset.monicaRunButton = ref
  const reason = document.createElement('span')
  reason.style.cssText = 'color:var(--fgColor-danger, #d1242f);font-size:12px'
  button.addEventListener('click', async (event) => {
    // 行は Issue への link なので、押しても画面を移らせない。
    event.preventDefault()
    event.stopPropagation()
    // GitHub のページの script が .click() で押した run は通さない。
    if (!event.isTrusted || button.disabled) return
    button.disabled = true
    button.textContent = LABELS.running
    reason.textContent = ''
    const reply = await send<RunFromButtonReply>({ type: 'monica.runFromButton', ref })
    if (reply?.ran) return
    button.disabled = false
    button.textContent = LABELS[run]
    reason.textContent = reply ? reply.reason : 'the monica desktop is not running'
  })
  wrapper.append(button, reason)
  return wrapper
}

let pending: ReturnType<typeof setTimeout> | undefined
function scheduleScan() {
  clearTimeout(pending)
  pending = setTimeout(() => void scan(), 150)
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
})
scheduleScan()
