import type { RunButton } from '@monica/task/contract'

import type { RunButtonRequest, RunButtonsReply, RunFromButtonReply } from './run-button-relay.ts'

// github.com のどの画面にも注入され、GitHub は画面を client 側で移るので、一覧かは走査のたびに URL で見る。
const ISSUES_PATH = /^\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?\/?$/
const TITLE_LINK = 'a[data-testid="issue-listitem-title-link"]'

const buttons = new WeakMap<HTMLAnchorElement, HTMLElement>()

const LABELS: Record<RunButton['run'], string> = { new: 'Run', resume: '再開', running: '実行中' }

/** Issues の一覧なら number が無く、Issue の画面なら number がある。 */
function issuesPathOf(pathname: string): { repo: string; number: string | undefined } | null {
  const match = ISSUES_PATH.exec(pathname)
  if (!match) return null
  const [, owner, name, number] = match
  return { repo: `${owner}/${name}`, number }
}

function listedRepo(): string | null {
  const path = issuesPathOf(location.pathname)
  return path && path.number === undefined ? path.repo : null
}

function refOf(link: HTMLAnchorElement, repo: string): string | null {
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin) return null
  const path = issuesPathOf(url.pathname)
  if (!path || path.number === undefined) return null
  if (path.repo.toLowerCase() !== repo.toLowerCase()) return null
  return `${path.repo}#${path.number}`
}

async function send<T>(request: RunButtonRequest): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as T
  } catch {
    // Chrome Extension の reload の後は、古い content script から service worker に届かない。
    return null
  }
}

// Backend に届かなかったら、desktop を起こして画面に戻る（focus）まで問い直さない。DOM の変化のたびに host を起こさないため。
let backendOutOfReach = false

async function scan() {
  const repo = listedRepo()
  if (!repo || backendOutOfReach) return
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
  if (!reply) {
    backendOutOfReach = true
    for (const [ref, links] of asked) {
      for (const link of links) if (link.dataset.monicaRef === ref) delete link.dataset.monicaRef
    }
    return
  }
  for (const { ref, button } of reply.buttons) {
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
    reason.textContent = reply ? reply.reason : 'Monica was reloaded; reload this page'
  })
  wrapper.append(button, reason)
  return wrapper
}

let pending: ReturnType<typeof setTimeout> | undefined
function scheduleScan() {
  clearTimeout(pending)
  pending = setTimeout(() => void scan(), 150)
}

function retryBackend() {
  if (document.visibilityState !== 'visible') return
  backendOutOfReach = false
  scheduleScan()
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
})
window.addEventListener('focus', retryBackend)
document.addEventListener('visibilitychange', retryBackend)
scheduleScan()
