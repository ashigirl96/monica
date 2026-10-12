import type { Pressable, RunButton, RunButtonRow } from '@monica/task/contract'

import type { PressReply, RunButtonRequest, RunButtonsReply } from './run-button-relay.ts'

// github.com のどの画面にも注入され、GitHub は画面を client 側で移るので、一覧か Issue の画面かは走査のたびに URL で見る。
const ISSUES_PATH = /^\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?\/?$/
const TITLE_LINK = 'a[data-testid="issue-listitem-title-link"]'
const HEADER = '[data-testid="issue-header"]'
// GitHub は class 名を `<Name>-module__<name>__<hash>` と `<name>__<hash>` の 2 つの形で混ぜて出し、hash は build ごとに変わるので、両方の形の hash の前までで当てる。
const METADATA = '[class*="MetadataContainer-module__container"], [class*="metadataContainer__"]'
// header は幅でどちらかを CSS で隠す New issue の container を 2 つ持つので、両方に差し込む。
const HEADER_ACTIONS = '[class*="HeaderMenu-module__buttonContainer"], [class*="buttonContainer__"]'
const TITLE_NUMBER = /^#\d+$/

const buttons = new WeakMap<HTMLElement, HTMLElement[]>()

const LABELS: Record<RunButton['run'], string> = {
  new: 'Run',
  resume: 'Resume',
  running: 'Running',
  reopen: 'Reopen',
}

const PRESSED: Record<Pressable, string> = {
  new: LABELS.running,
  resume: LABELS.running,
  reopen: 'Reopening',
}

/** Issues の一覧なら number が無く、Issue の画面なら number がある。 */
function issuesPathOf(pathname: string): { repo: string; number: string | undefined } | null {
  const match = ISSUES_PATH.exec(pathname)
  if (!match) return null
  const [, owner, name, number] = match
  return { repo: `${owner}/${name}`, number }
}

type Layout = {
  buttonClass: string
  margin: 'margin-left' | 'margin-right'
  place(host: HTMLElement, cell: HTMLElement, refusal?: HTMLElement): void
}

const LIST_ROW: Layout = {
  buttonClass: 'btn btn-sm btn-primary',
  margin: 'margin-left',
  place(titleLink, cell, refusal) {
    if (refusal) titleLink.after(refusal)
    const metadata = titleLink.closest('li')?.querySelector(METADATA)
    if (metadata) metadata.append(cell)
    else titleLink.after(cell)
  },
}

const ISSUE_HEADER: Layout = {
  // New issue と同じ高さにする。
  buttonClass: 'btn btn-primary',
  margin: 'margin-right',
  // New issue を header の右端に残す。
  place(newIssueContainer, cell, refusal) {
    newIssueContainer.prepend(...(refusal ? [refusal, cell] : [cell]))
  },
}

type Slot = { host: HTMLElement; ref: string; layout: Layout }

function slotsOnPage(): Slot[] {
  const path = issuesPathOf(location.pathname)
  if (!path) return []
  if (path.number !== undefined) {
    const pageRef = refOf({ repo: path.repo, number: path.number })
    return [...document.querySelectorAll<HTMLElement>(HEADER)].flatMap((header) => {
      const titleNumber = ownedBy(header, header.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter((link) => TITLE_NUMBER.test(link.textContent?.trim() ?? ''))
        .map(issueOf)
        .find((issue) => issue !== null)
      const ref = titleNumber ? refOf(titleNumber) : pageRef
      return ownedBy(header, header.querySelectorAll<HTMLElement>(HEADER_ACTIONS)).map((host) => ({
        host,
        ref,
        layout: ISSUE_HEADER,
      }))
    })
  }
  return [...document.querySelectorAll<HTMLAnchorElement>(TITLE_LINK)].flatMap((host) => {
    const issue = issueOf(host)
    if (!issue || issue.repo.toLowerCase() !== path.repo.toLowerCase()) return []
    return [{ host, ref: refOf(issue), layout: LIST_ROW }]
  })
}

// sub-issue を開いた横のパネルは path を親のままにして、自分への `#<n>` の link を持つ header を足す。header が入れ子でも、外側に内側の要素を拾わせない。
function ownedBy<E extends Element>(header: HTMLElement, elements: NodeListOf<E>): E[] {
  return [...elements].filter((element) => element.closest(HEADER) === header)
}

type Issue = { repo: string; number: string }

function issueOf(link: HTMLAnchorElement): Issue | null {
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin) return null
  const path = issuesPathOf(url.pathname)
  if (!path || path.number === undefined) return null
  return { repo: path.repo, number: path.number }
}

function refOf({ repo, number }: Issue): string {
  return `${repo}#${number}`
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
  if (backendOutOfReach) return
  const asked = new Map<string, Slot[]>()
  for (const slot of slotsOnPage()) {
    const { host, ref } = slot
    // GitHub が要素を使い回して別の Issue を描いたら、前のボタンを外して決め直す。
    if (host.dataset.monicaRef === ref) continue
    for (const element of buttons.get(host) ?? []) element.remove()
    host.dataset.monicaRef = ref
    asked.set(ref, [...(asked.get(ref) ?? []), slot])
  }
  if (asked.size === 0) return
  const reply = await send<RunButtonsReply>({ type: 'monica.runButtons', refs: [...asked.keys()] })
  if (!reply) {
    backendOutOfReach = true
    for (const [ref, slots] of asked) {
      for (const { host } of slots)
        if (host.dataset.monicaRef === ref) delete host.dataset.monicaRef
    }
    return
  }
  for (const row of reply.buttons) {
    for (const slot of asked.get(row.ref) ?? []) {
      if (slot.host.dataset.monicaRef === row.ref && slot.host.isConnected) draw(slot, row)
    }
  }
}

// ボタンも reason も無い行（読めなかった Issue）には何も出さない。
function draw(slot: Slot, { button, reason }: RunButtonRow) {
  const { host, layout } = slot
  if (button) {
    const { cell, refusal } = runButtonFor(slot, button.run)
    buttons.set(host, [cell, refusal])
    layout.place(host, cell, refusal)
  } else if (reason) {
    const cell = disabledRunButtonFor(slot, reason)
    buttons.set(host, [cell])
    layout.place(host, cell)
  }
}

function buttonCell({ ref, layout }: Slot): { cell: HTMLElement; button: HTMLButtonElement } {
  const cell = document.createElement('span')
  cell.style.cssText = `display:inline-flex;align-items:center;${layout.margin}:8px`
  const button = document.createElement('button')
  button.type = 'button'
  button.className = layout.buttonClass
  button.dataset.monicaRunButton = ref
  cell.append(button)
  return { cell, button }
}

function disabledRunButtonFor(slot: Slot, reason: string): HTMLElement {
  const { cell, button } = buttonCell(slot)
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

// Issue の画面では隠れた側の container にも同じ ref のボタンがあるので、ref の付いた要素をすべて描き直す。
function redraw(ref: string, row: RunButtonRow) {
  for (const slot of slotsOnPage()) {
    if (slot.host.dataset.monicaRef !== ref) continue
    for (const element of buttons.get(slot.host) ?? []) element.remove()
    buttons.delete(slot.host)
    draw(slot, row)
  }
}

function runButtonFor(
  slot: Slot,
  run: RunButton['run'],
): { cell: HTMLElement; refusal: HTMLElement } {
  const { ref, layout } = slot
  const { cell, button } = buttonCell(slot)
  button.textContent = LABELS[run]
  button.disabled = run === 'running'
  const refusal = document.createElement('span')
  refusal.style.cssText = `align-self:center;color:var(--fgColor-danger, #d1242f);font-size:12px;${layout.margin}:8px`
  button.addEventListener('click', async (event) => {
    // 一覧の行は Issue への link なので、押しても画面を移らせない。
    event.preventDefault()
    event.stopPropagation()
    // GitHub のページの script が .click() で押した run は通さない。
    if (!event.isTrusted || button.disabled || run === 'running') return
    button.disabled = true
    button.textContent = PRESSED[run]
    refusal.textContent = ''
    const reply = await send<PressReply>({ type: 'monica.press', ref, run })
    if (reply && 'row' in reply) {
      redraw(ref, reply.row)
      return
    }
    button.disabled = false
    button.textContent = LABELS[run]
    refusal.textContent = reply ? reply.failed : 'Monica was reloaded; reload this page'
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
