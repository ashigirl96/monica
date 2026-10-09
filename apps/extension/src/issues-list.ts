import type { RunButton } from '@monica/task/contract'

import type { RunButtonRequest, RunButtonsReply, RunFromButtonReply } from './run-button-relay.ts'

// github.com のどの画面にも注入され、GitHub は画面を client 側で移るので、一覧かは走査のたびに URL で見る。
const ISSUES_PATH = /^\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?\/?$/
const TITLE_LINK = 'a[data-testid="issue-listitem-title-link"]'
// class 名の末尾は GitHub の build ごとに変わる hash なので、前の部分で当てる。
const METADATA = '[class*="MetadataContainer-module__container"]'

const buttons = new WeakMap<HTMLAnchorElement, HTMLElement[]>()

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
    for (const element of buttons.get(link) ?? []) element.remove()
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
  for (const { ref, button, reason } of reply.buttons) {
    if (!button && !reason) continue
    for (const link of asked.get(ref) ?? []) {
      if (link.dataset.monicaRef !== ref || !link.isConnected) continue
      if (button) {
        const { cell, refusal } = runButtonFor(ref, button.run)
        buttons.set(link, [cell, refusal])
        link.after(refusal)
        placeCell(link, cell)
      } else if (reason) {
        const cell = disabledRunButtonFor(ref, reason)
        buttons.set(link, [cell])
        placeCell(link, cell)
      }
    }
  }
}

function placeCell(link: HTMLAnchorElement, cell: HTMLElement) {
  const metadata = link.closest('li')?.querySelector(METADATA)
  if (metadata) metadata.append(cell)
  else link.after(cell)
}

function buttonCell(ref: string): { cell: HTMLElement; button: HTMLButtonElement } {
  const cell = document.createElement('span')
  cell.style.cssText = 'display:inline-flex;align-items:center;margin-left:8px'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-sm btn-primary'
  button.dataset.monicaRunButton = ref
  cell.append(button)
  return { cell, button }
}

function disabledRunButtonFor(ref: string, reason: string): HTMLElement {
  const { cell, button } = buttonCell(ref)
  button.textContent = LABELS.new
  // disabled の button は focus できず、理由がキーボードと支援技術に届かない。
  button.setAttribute('aria-disabled', 'true')
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  cell.append(tooltipFor(button, reason))
  return cell
}

const VIEWPORT_MARGIN = 8

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

let lastTooltipId = 0
let hideShownTooltip: (() => void) | undefined
const showTooltipOf = new WeakMap<Element, () => void>()

// macOS の Chromium は窓が key でないと title の tooltip を描かないので、自前で出す。
function tooltipFor(button: HTMLButtonElement, text: string): HTMLElement {
  const tooltip = document.createElement('span')
  tooltip.id = `monica-run-tooltip-${++lastTooltipId}`
  tooltip.setAttribute('role', 'tooltip')
  tooltip.textContent = text
  tooltip.hidden = true
  tooltip.style.cssText =
    'position:fixed;top:0;left:0;z-index:2147483647;max-width:min(320px, calc(100vw - 16px));padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.5;white-space:normal;pointer-events:none;color:var(--fgColor-onEmphasis, #fff);background:var(--bgColor-emphasis, #25292e)'
  button.setAttribute('aria-describedby', tooltip.id)

  function dismissOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') hide()
  }
  // fixed の tooltip はスクロールで button から離れるので、スクロールしたら消す。
  function hide() {
    tooltip.hidden = true
    window.removeEventListener('scroll', hide, true)
    document.removeEventListener('keydown', dismissOnEscape, true)
    if (hideShownTooltip === hide) hideShownTooltip = undefined
  }
  function show() {
    if (hideShownTooltip !== hide) hideShownTooltip?.()
    hideShownTooltip = hide
    // 前に置いた left が残ると、その右の幅で折り返した大きさを測ってしまう。
    tooltip.style.left = '0px'
    tooltip.hidden = false
    const rect = button.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    const { offsetWidth: width, offsetHeight: height } = tooltip
    const below = rect.bottom + 4
    const above = rect.top - 4 - height
    const top =
      below + height <= clientHeight - VIEWPORT_MARGIN || above < VIEWPORT_MARGIN ? below : above
    tooltip.style.left = `${clamp(rect.right - width, VIEWPORT_MARGIN, clientWidth - VIEWPORT_MARGIN - width)}px`
    tooltip.style.top = `${clamp(top, VIEWPORT_MARGIN, clientHeight - VIEWPORT_MARGIN - height)}px`
    window.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', dismissOnEscape, true)
  }
  showTooltipOf.set(button, show)
  button.addEventListener('mouseenter', show)
  button.addEventListener('focus', show)
  // hover と focus の片方が残っているあいだは出したままにする。
  button.addEventListener('mouseleave', () => {
    if (document.activeElement === button) return
    hide()
    // hover で隠した、focus 中の別の Run の tooltip を出し直す。
    const focused = document.activeElement
    if (focused) showTooltipOf.get(focused)?.()
  })
  button.addEventListener('blur', () => {
    if (!button.matches(':hover')) hide()
  })
  return tooltip
}

function runButtonFor(
  ref: string,
  run: RunButton['run'],
): { cell: HTMLElement; refusal: HTMLElement } {
  const { cell, button } = buttonCell(ref)
  button.textContent = LABELS[run]
  button.disabled = run === 'running'
  const refusal = document.createElement('span')
  refusal.style.cssText = 'color:var(--fgColor-danger, #d1242f);font-size:12px;margin-left:8px'
  button.addEventListener('click', async (event) => {
    // 行は Issue への link なので、押しても画面を移らせない。
    event.preventDefault()
    event.stopPropagation()
    // GitHub のページの script が .click() で押した run は通さない。
    if (!event.isTrusted || button.disabled) return
    button.disabled = true
    button.textContent = LABELS.running
    refusal.textContent = ''
    const reply = await send<RunFromButtonReply>({ type: 'monica.runFromButton', ref })
    if (reply?.ran) return
    button.disabled = false
    button.textContent = LABELS[run]
    refusal.textContent = reply ? reply.reason : 'Monica was reloaded; reload this page'
  })
  return { cell, refusal }
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
