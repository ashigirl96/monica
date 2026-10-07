import type { ContractRouterClient } from '@orpc/contract'
import { type PopoverAnchor, pushErrorToast, pushInfoToast } from '@tania/ui'
import { atom, type Getter, type Setter } from 'jotai'
import { atomWithDefault } from 'jotai/utils'

import type { contract, Layout, ListedAgentSession, RepoPlace, Tab } from '../contract.ts'
import { agentDotOf } from './agent-dot.ts'
import { jumpHintsActiveAtom } from './jump-hints.ts'
import {
  type BenchLabelOf,
  buildSidebar,
  cycledRunspaceIds,
  isPathTitle,
  sectionPeersOf,
  type Sidebar,
} from './sidebar-model.ts'
import { getTabTerminal, releaseTabConnection } from './terminal-connections.ts'
import {
  applyTerminalSessionListAtom,
  detachedTerminalSessionsAtom,
  isDeadStatus,
  markEndedAtom,
  setTerminalSessionStatusAtom,
  type TerminalSessionStatusEntry,
  terminalSessionStatusAtom,
} from './terminal-sessions.ts'
import { terminalDetach } from './terminal.ts'
import { collapsedSectionsAtom, railChoiceAtom, savedUiStateAtom } from './ui-state.ts'

export type WorkbenchClient = ContractRouterClient<typeof contract>
export type Runspace = Layout['runspaces'][number]

// oRPC の client は callable な Proxy で、jotai の set が updater と取り違えるので `() => client` で渡す。
export const workbenchClientAtom = atom<WorkbenchClient | null>(null)

export const layoutAtom = atom<Layout | null>(null)

// workbench は誰が Runspace を所有するかを知らないので、閉じて空になった所有された Runspace は slot に渡す（ADR-0005）。
export const lastTabClosedAtom = atom<((runspaceId: string) => void) | null>(null)

export const terminalFocusRequestAtom = atom(0)

function clientOf(get: Getter): WorkbenchClient {
  const client = get(workbenchClientAtom)
  if (!client) throw new Error('Backend is unavailable')
  return client
}

export function warnFailed(what: string, e: unknown): void {
  console.warn(`${what} failed:`, e)
}

// Backend が居ないと layout を変える操作は失敗するが、画面は塞がず toast で 1 行知らせる。
function action<Args extends unknown[]>(
  run: (get: Getter, set: Setter, ...args: Args) => Promise<void>,
) {
  return atom(null, async (get, set, ...args: Args) => {
    try {
      await run(get, set, ...args)
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e))
    }
  })
}

const DEFAULT_SIZE = { rows: 24, cols: 80 }

// 新しい Tab の pane はまだ無いので、同じ領域に出ている Tab の大きさで作り、attach の resize で追いつかせる。
function sizeOf(tab: Tab | null) {
  const term = tab && getTabTerminal(tab.id)
  return term ? { rows: term.rows, cols: term.cols } : DEFAULT_SIZE
}

async function load(get: Getter, set: Setter) {
  const client = clientOf(get)
  let layout = await client.layout.get()
  // 所有されていない Runspace が 1 つも無い画面は作らず、最後の Tab が閉じたら新しい Runspace で始める。
  if (layout.runspaces.length === 0) {
    await client.runspace.create(DEFAULT_SIZE)
    layout = await client.layout.get()
  }
  const sessions = await client.terminalSession.list()
  const front = frontTab(get)
  set(layoutAtom, layout)
  // 見ていた端末が画面から消えないよう、手前の Tab はどの経路で移っても移った先までついていく。
  const moved = front && findTab(get, front.tab.id)
  if (moved && moved.runspace.id !== front.runspace.id) {
    set(setActiveAtom, { runspaceId: moved.runspace.id, tabId: moved.tab.id })
  }
  set(applyTerminalSessionListAtom, sessions)
  void set(resolvePlacesAtom)
}

// 応答が前後して古い一覧で上書きしないよう読み直しは 1 本ずつ流し、待つ間に来た要求は 1 回にまとめる。
function serialReload(read: (get: Getter, set: Setter) => Promise<void>) {
  // promise は jotai が値として追跡するので、object に包んで持つ。
  const lastAtom = atom<{ done: Promise<void> }>({ done: Promise.resolve() })
  const waitingAtom = atom<{ done: Promise<void> } | null>(null)
  return atom(null, (get, set): Promise<void> => {
    const waiting = get(waitingAtom)
    if (waiting) return waiting.done
    const reload = {
      done: get(lastAtom).done.then(() => {
        set(waitingAtom, null)
        return read(get, set)
      }),
    }
    set(waitingAtom, reload)
    set(lastAtom, { done: reload.done.catch(() => {}) })
    return reload.done
  })
}

export const reloadAtom = serialReload(load)

const agentSessionsAtom = atom<ListedAgentSession[]>([])

// hook は tool のたびに届くので、Agent Session は layout と別に読み直す。
export const reloadAgentSessionsAtom = serialReload(async (get, set) => {
  set(agentSessionsAtom, await clientOf(get).agentSession.list())
})

export const agentSessionByTerminalSessionAtom = atom(
  (get) => new Map(get(agentSessionsAtom).map((a) => [a.terminalSessionId, a])),
)

export const agentDotOfTerminalSessionAtom = atom((get) => {
  const byTerminalSession = get(agentSessionByTerminalSessionAtom)
  return (terminalSessionId: string) => agentDotOf(byTerminalSession.get(terminalSessionId))
})

export const unreadOfTerminalSessionAtom = atom((get) => {
  const byTerminalSession = get(agentSessionByTerminalSessionAtom)
  return (terminalSessionId: string) => byTerminalSession.get(terminalSessionId)?.unread ?? false
})

// active な Runspace と Tab は Workbench Ledger に持たないので、id が layout から消えたら先頭を見せる。
const activeRunspaceIdAtom = atomWithDefault((get) => get(savedUiStateAtom).activeRunspaceId)
const activeTabIdsAtom = atomWithDefault((get): Record<string, string> => {
  const { activeRunspaceId, activeTabId } = get(savedUiStateAtom)
  return activeRunspaceId && activeTabId ? { [activeRunspaceId]: activeTabId } : {}
})

export const activeRunspaceAtom = atom((get): Runspace | null => {
  const runspaces = get(layoutAtom)?.runspaces ?? []
  const id = get(activeRunspaceIdAtom)
  return runspaces.find((r) => r.id === id) ?? runspaces[0] ?? null
})

function activeTabOf(get: Getter, runspace: Runspace): Tab | null {
  const id = get(activeTabIdsAtom)[runspace.id]
  return runspace.tabs.find((t) => t.id === id) ?? runspace.tabs[0] ?? null
}

export const activeTerminalTabAtom = atom((get) => {
  const runspace = get(activeRunspaceAtom)
  return runspace ? activeTabOf(get, runspace) : null
})

export const copyActiveAgentSessionIdAtom = atom(null, (get): boolean => {
  const tab = get(activeTerminalTabAtom)
  const id = tab && get(agentSessionByTerminalSessionAtom).get(tab.terminalSessionId)?.sessionId
  if (!id) return false
  navigator.clipboard.writeText(id).then(
    () => pushInfoToast(`Session ID copied: ${id.slice(0, 8)}…`),
    (e: unknown) => pushErrorToast(`Session ID copy failed: ${e}`),
  )
  return true
})

// 切り替えはすべてここを通るので、jump hint を閉じるのも、選んだ札を active な Runspace の札に合わせるのもここで行う。
const setActiveAtom = atom(null, (get, set, next: { runspaceId: string; tabId?: string }) => {
  const before = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id]
  set(activeRunspaceIdAtom, next.runspaceId)
  const { tabId } = next
  if (tabId) set(activeTabIdsAtom, (prev) => ({ ...prev, [next.runspaceId]: tabId }))
  const after = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id]
  if (before[0] !== after[0] || before[1] !== after[1]) set(jumpHintsActiveAtom, false)
  // Pinned はどの札でも見えているので、札を替えない。
  const rail = after[0] && get(sidebarAtom).railKeys[after[0]]
  if (before[0] !== after[0] && rail) set(railChoiceAtom, rail)
})

// 通知を click しても Tab へは移れないので、Runspace を選ぶと未読の Tab へ 1 手で着くようにする。
export const activateRunspaceAtom = atom(null, (get, set, runspaceId: string) => {
  const unreadOf = get(unreadOfTerminalSessionAtom)
  const unread = get(layoutAtom)
    ?.runspaces.find((r) => r.id === runspaceId)
    ?.tabs.find((t) => unreadOf(t.terminalSessionId))
  set(setActiveAtom, { runspaceId, tabId: unread?.id })
  set(terminalFocusRequestAtom, (c) => c + 1)
})

export const activateTerminalTabAtom = atom(null, (get, set, tabId: string) => {
  const runspace = get(activeRunspaceAtom)
  if (!runspace?.tabs.some((t) => t.id === tabId)) return
  set(setActiveAtom, { runspaceId: runspace.id, tabId })
  set(terminalFocusRequestAtom, (c) => c + 1)
})

// OSC 0/2 の title は shell が prompt のたびに書き換えるので、Workbench Ledger に書かず memory にだけ持つ。
export const tabTitlesAtom = atom<Record<string, string>>({})

// OSC 7 を出す shell の title は同じ cwd の `~` 付きの別表記なので、そういう Tab の cwd は OSC 7 だけから取る。
const tabsReportingCwdAtom = atom<ReadonlySet<string>>(new Set<string>())

// OSC 7 を出さない shell でも、title を path にする設定なら cwd を追える。
export const updateTabTitleAtom = atom(null, (get, set, tabId: string, title: string) => {
  set(tabTitlesAtom, (prev) => ({ ...prev, [tabId]: title }))
  // shell は prompt のたびに title を書くので、command の後で branch が変わったかもしれない合図になる。
  const tab = findTab(get, tabId)?.tab
  if (tab) void set(resolvePlacesAtom, [tab.cwd])
  // `~user` や zsh の named directory は Backend が絶対 path にできないので、`~` と `~/` の形だけを取る。
  if (!isPathTitle(title) || get(tabsReportingCwdAtom).has(tabId)) return Promise.resolve()
  return writeCwd(get, set, tabId, title)
})

export const updateTabCwdAtom = atom(null, (get, set, tabId: string, cwd: string) => {
  if (!get(tabsReportingCwdAtom).has(tabId)) {
    set(tabsReportingCwdAtom, (prev) => new Set(prev).add(tabId))
  }
  void set(resolvePlacesAtom, [cwd])
  return writeCwd(get, set, tabId, cwd)
})

// cwd は prompt のたびに届くので、Tab ごとに最後に送った値と比べ、変わったときだけ書く。
const sentCwdsAtom = atom<Record<string, string>>({})
// 応答が前後して古い cwd が最後に残らないよう、書き込みは 1 本の列で流す。
const cwdWritesAtom = atom<{ done: Promise<void> }>({ done: Promise.resolve() })

function writeCwd(get: Getter, set: Setter, tabId: string, cwd: string): Promise<void> {
  if (cwd === (get(sentCwdsAtom)[tabId] ?? findTab(get, tabId)?.tab.cwd)) return Promise.resolve()
  set(sentCwdsAtom, (prev) => ({ ...prev, [tabId]: cwd }))
  const forget = () =>
    set(sentCwdsAtom, (prev) => {
      if (prev[tabId] !== cwd) return prev
      const { [tabId]: _, ...rest } = prev
      return rest
    })
  const done = get(cwdWritesAtom)
    .done.then(() => clientOf(get).tab.setCwd({ id: tabId, cwd }))
    .catch((e: unknown) => {
      // 届かなかった cwd は、次に同じ値が来たときに送り直す。
      forget()
      if (!isGone(e)) warnFailed('cwd update', e)
    })
  set(cwdWritesAtom, { done })
  return done
}

// checkout は clone や削除で後から現れたり消えたりするので layout の読み直しと shell の知らせのたびに引き直し、
// title を書き換え続ける app に備えて cwd ごとに 5 秒で間引く。
const placesAtom = atom<Record<string, RepoPlace>>({})
const placesCheckedAtAtom = atom<Record<string, number>>({})
const PLACE_RECHECK_MS = 5000

// cwds を省けば、layout の Runspace と Tab の cwd と、Detached の cwd を引き直す。
const resolvePlacesAtom = atom(null, async (get, set, cwds?: string[]) => {
  const checkedAt = get(placesCheckedAtAtom)
  const now = Date.now()
  const candidates = cwds ?? [
    ...(get(layoutAtom)?.runspaces ?? []).flatMap((r) => [r.cwd, ...r.tabs.map((t) => t.cwd)]),
    ...get(detachedTerminalSessionsAtom).map((s) => s.cwd),
  ]
  const due = [...new Set(candidates)].filter(
    (cwd) => now - (checkedAt[cwd] ?? 0) >= PLACE_RECHECK_MS,
  )
  const client = get(workbenchClientAtom)
  if (due.length === 0 || !client) return
  set(placesCheckedAtAtom, (prev) => ({
    ...prev,
    ...Object.fromEntries(due.map((cwd) => [cwd, now])),
  }))
  // 引けなかった cwd は前の値のまま残し、5 秒後の次の合図で引き直す。
  const found: Record<string, RepoPlace> = {}
  await Promise.all(
    due.map(async (cwd) => {
      try {
        found[cwd] = await client.repo.of({ cwd })
      } catch (e) {
        warnFailed('repo of', e)
      }
    }),
  )
  set(placesAtom, (prev) => ({ ...prev, ...found }))
})

export const resolveEditorPathsAtom = atom(null, (get, _set, cwd: string, candidates: string[]) =>
  clientOf(get).editor.resolve({ cwd, candidates }),
)

// エディタが開けなくても端末の操作は続けられるので、知らせない。
export const openInEditorAtom = atom(null, (get, _set, path: string) => {
  get(workbenchClientAtom)
    ?.editor.open({ path })
    .catch((e: unknown) => warnFailed('editor open', e))
})

// workbench は誰が Runspace を所有するかを知らないので、Bench の Task の Repo と Issue は slot から受ける（ADR-0005）。
export const benchLabelOfAtom = atom<BenchLabelOf | null>(null)

export const sidebarAtom = atom((get): Sidebar =>
  buildSidebar({
    runspaces: get(layoutAtom)?.runspaces ?? [],
    activeRunspaceId: get(activeRunspaceAtom)?.id ?? null,
    activeTabOf: (runspace) => activeTabOf(get, runspace),
    titles: get(tabTitlesAtom),
    places: get(placesAtom),
    unreadOf: get(unreadOfTerminalSessionAtom),
    benchLabelOf: get(benchLabelOfAtom) ?? (() => null),
    detached: get(detachedTerminalSessionsAtom),
    railChoice: get(railChoiceAtom),
    collapsed: get(collapsedSectionsAtom),
  }),
)

export const toggleSectionAtom = atom(null, (_get, set, key: string) =>
  set(collapsedSectionsAtom, (prev) => {
    const next = new Set(prev)
    if (!next.delete(key)) next.add(key)
    return next
  }),
)

export const createRunspaceAtom = action(async (get, set) => {
  const active = get(activeRunspaceAtom)
  const tab = get(activeTerminalTabAtom)
  const { runspaceId } = await clientOf(get).runspace.create({
    cwd: tab?.cwd,
    index: active ? active.sortOrder + 1 : undefined,
    ...sizeOf(tab),
  })
  await set(reloadAtom)
  set(activateRunspaceAtom, runspaceId)
})

export const createTerminalTabAtom = action(async (get, set) => {
  const runspace = get(activeRunspaceAtom)
  if (!runspace) return
  const tab = activeTabOf(get, runspace)
  const opened = await clientOf(get).tab.open({
    runspaceId: runspace.id,
    cwd: tab?.cwd,
    index: tab ? tab.sortOrder + 1 : undefined,
    ...sizeOf(tab),
  })
  await set(reloadAtom)
  set(activateTerminalTabAtom, opened.id)
})

type TabInRunspace = { runspace: Runspace; tab: Tab }

function findTab(get: Getter, tabId: string): TabInRunspace | null {
  for (const runspace of get(layoutAtom)?.runspaces ?? []) {
    const tab = runspace.tabs.find((t) => t.id === tabId)
    if (tab) return { runspace, tab }
  }
  return null
}

function frontTab(get: Getter): TabInRunspace | null {
  const runspace = get(activeRunspaceAtom)
  const tab = runspace && activeTabOf(get, runspace)
  return runspace && tab ? { runspace, tab } : null
}

// 別の経路（Exit と手の close、CLI）で先に消えた Tab は、閉じたのと同じに扱う。
function isGone(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'NOT_FOUND'
}

function detachTab(tab: Tab) {
  const terminalSessionId = releaseTabConnection(tab.id) ?? tab.terminalSessionId
  terminalDetach(terminalSessionId).catch((e: unknown) => warnFailed('terminal detach', e))
}

const EXIT_POLL_MS = 50
const EXIT_WAIT_MS = 3000

// Agent Session は Backend が ptyd の Exit を記録したときに終わるので、その前に Task の close を頼むと、
// 終わらせた claude が live な Run に見えて guard に止められる。
async function untilExitRecorded(get: Getter, terminalSessionId: string) {
  for (let waited = 0; waited < EXIT_WAIT_MS; waited += EXIT_POLL_MS) {
    const listed = await clientOf(get).terminalSession.list()
    if (!listed.some((s) => s.id === terminalSessionId && !isDeadStatus(s.status))) return
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
  }
}

async function closeTab(
  get: Getter,
  set: Setter,
  { runspace, tab }: TabInRunspace,
  shell: 'kept' | 'ending',
) {
  // 空になったかは close の transaction で決まる。読み直した layout では、間に Tab を外へ移した分と区別できない。
  let emptiedRunspaceId: string | null = null
  try {
    emptiedRunspaceId = (await clientOf(get).tab.close({ id: tab.id })).emptiedRunspaceId
  } catch (e) {
    if (!isGone(e)) throw e
  }
  if (shell === 'kept') detachTab(tab)
  if (activeTabOf(get, runspace)?.id === tab.id) {
    const rest = runspace.tabs.filter((t) => t.id !== tab.id)
    const next = rest[Math.min(runspace.tabs.indexOf(tab), rest.length - 1)]
    if (next) set(activeTabIdsAtom, (prev) => ({ ...prev, [runspace.id]: next.id }))
  }
  await set(reloadAtom)
  if (!emptiedRunspaceId) return
  if (shell === 'ending') await untilExitRecorded(get, tab.terminalSessionId)
  get(lastTabClosedAtom)?.(emptiedRunspaceId)
}

export const closeTerminalTabAtom = action(async (get, set, tabId?: string) => {
  const found = tabId ? findTab(get, tabId) : frontTab(get)
  if (found) await closeTab(get, set, found, 'kept')
})

// 接続中の Tab は Exit で閉じるので、閉じ終わるまでの間も終わった印を出さない。
const closingTabIdsAtom = atom<ReadonlySet<string>>(new Set<string>())

export const deadTabsAtom = atom((get) => {
  const statuses = get(terminalSessionStatusAtom)
  const closing = get(closingTabIdsAtom)
  const dead: Record<string, TerminalSessionStatusEntry> = {}
  for (const tab of get(layoutAtom)?.runspaces.flatMap((r) => r.tabs) ?? []) {
    const entry = statuses[tab.terminalSessionId]
    if (entry && isDeadStatus(entry.status) && !closing.has(tab.id)) dead[tab.id] = entry
  }
  return dead
})

// Exit の後は止める出力が無いので、detach を送らずに閉じる。
export const tabExitedAtom = action(
  async (get, set, tabId: string, terminalSessionId: string, exitCode: number | null) => {
    const found = findTab(get, tabId)
    // Backend の張り直しが先に届いた Tab は、もう新しい shell を指している。
    if (found?.tab.terminalSessionId !== terminalSessionId) return
    releaseTabConnection(tabId)
    set(markEndedAtom, terminalSessionId)
    set(setTerminalSessionStatusAtom, terminalSessionId, { status: 'exited', exitCode })
    // pin された Tab は Backend が張り直す。
    if (found.tab.pinned) return
    set(closingTabIdsAtom, (prev) => new Set(prev).add(tabId))
    try {
      await closeTab(get, set, found, 'ending')
    } finally {
      set(closingTabIdsAtom, (prev) => new Set([...prev].filter((id) => id !== tabId)))
    }
  },
)

export const toggleTabPinAtom = action(async (get, set, tabId?: string) => {
  const found = tabId ? findTab(get, tabId) : frontTab(get)
  if (!found) return
  const { id, pinned } = found.tab
  const client = clientOf(get)
  await (pinned ? client.tab.unpin({ id }) : client.tab.pin({ id }))
  await set(reloadAtom)
})

export const startNewShellForTabAtom = action(async (get, set, tabId: string) => {
  const found = findTab(get, tabId)
  if (!found) return
  releaseTabConnection(tabId)
  await clientOf(get).tab.respawn({ id: tabId, ...sizeOf(found.tab) })
  await set(reloadAtom)
})

export const reattachTerminalSessionAtom = action(async (get, set, terminalSessionId: string) => {
  const runspace = get(activeRunspaceAtom)
  if (!runspace) return
  const tab = await clientOf(get).tab.open({
    runspaceId: runspace.id,
    terminalSessionId,
    ...sizeOf(activeTabOf(get, runspace)),
  })
  await set(reloadAtom)
  set(activateTerminalTabAtom, tab.id)
})

export const terminateTerminalSessionAtom = action(async (get, set, terminalSessionId: string) => {
  await clientOf(get).terminalSession.terminate({ id: terminalSessionId })
  set(markEndedAtom, terminalSessionId)
  await set(reloadAtom)
})

export type TabMenuState = {
  tabId: string
  anchor: PopoverAnchor
  confirmingTerminate: boolean
}

export const tabMenuAtom = atom<TabMenuState | null>(null)

export const tabMenuTabAtom = atom((get) => {
  const menu = get(tabMenuAtom)
  return menu ? (findTab(get, menu.tabId)?.tab ?? null) : null
})

export const terminateTabTerminalSessionAtom = action(async (get, set, tabId: string) => {
  const found = findTab(get, tabId)
  if (!found) return
  await clientOf(get).terminalSession.terminate({ id: found.tab.terminalSessionId })
  releaseTabConnection(tabId)
  set(markEndedAtom, found.tab.terminalSessionId)
  await closeTab(get, set, found, 'ending')
})

function cycle<T>(items: T[], current: T | null | undefined, step: 1 | -1): T | undefined {
  const index = current === null || current === undefined ? -1 : items.indexOf(current)
  return items[(index + step + items.length) % items.length]
}

export const cycleRunspaceAtom = atom(null, (get, set, direction: 'up' | 'down') => {
  const ids = cycledRunspaceIds(get(sidebarAtom))
  if (ids.length <= 1) return
  const next = cycle(ids, get(activeRunspaceAtom)?.id, direction === 'up' ? -1 : 1)
  if (next) set(setActiveAtom, { runspaceId: next })
})

export const cycleTerminalTabAtom = atom(null, (get, set, direction: 'left' | 'right') => {
  const runspace = get(activeRunspaceAtom)
  if (!runspace || runspace.tabs.length <= 1) return
  const next = cycle(runspace.tabs, activeTabOf(get, runspace), direction === 'left' ? -1 : 1)
  if (next) set(setActiveAtom, { runspaceId: runspace.id, tabId: next.id })
})

// 札とセクションは Workbench Ledger の並びより先に効くので、セクションをまたいで動かしても見た目の位置にならない。
async function moveRunspaceTo(get: Getter, set: Setter, id: string, toId: string) {
  if (!sectionPeersOf(get(sidebarAtom), id).includes(toId)) return
  const index = (get(layoutAtom)?.runspaces ?? []).findIndex((r) => r.id === toId)
  await clientOf(get).runspace.move({ id, index })
  await set(reloadAtom)
}

async function moveTab(get: Getter, set: Setter, id: string, runspaceId: string, index: number) {
  await clientOf(get).tab.move({ id, runspaceId, index })
  await set(reloadAtom)
}

export const reorderRunspacesAtom = action(moveRunspaceTo)

export const reorderTabsAtom = action(async (get, set, fromId: string, toId: string) => {
  const runspace = get(activeRunspaceAtom)
  const index = runspace?.tabs.findIndex((t) => t.id === toId) ?? -1
  if (runspace && index >= 0) await moveTab(get, set, fromId, runspace.id, index)
})

export const moveActiveRunspaceAtom = action(async (get, set, direction: 'up' | 'down') => {
  const active = get(activeRunspaceAtom)
  if (!active) return
  const peers = sectionPeersOf(get(sidebarAtom), active.id)
  const neighbor = peers[peers.indexOf(active.id) + (direction === 'up' ? -1 : 1)]
  if (!neighbor) return
  // 札の順はセクションの先頭の行の位置で決まるので、後ろの行を前の行の位置へ動かし、前の位置を保つ。
  if (direction === 'up') await moveRunspaceTo(get, set, active.id, neighbor)
  else await moveRunspaceTo(get, set, neighbor, active.id)
})

export const moveActiveTabAtom = action(async (get, set, direction: 'left' | 'right') => {
  const runspace = get(activeRunspaceAtom)
  const tab = runspace && activeTabOf(get, runspace)
  if (!runspace || !tab) return
  const index = runspace.tabs.indexOf(tab) + (direction === 'left' ? -1 : 1)
  if (index >= 0 && index < runspace.tabs.length) {
    await moveTab(get, set, tab.id, runspace.id, index)
  }
})

export const draggedTabIdAtom = atom<string | null>(null)

export const moveTabToRunspaceAtom = action(async (get, set, tabId: string, runspaceId: string) => {
  const found = findTab(get, tabId)
  const target = get(layoutAtom)?.runspaces.find((r) => r.id === runspaceId)
  if (!found || !target || found.runspace.id === runspaceId) return
  await moveTab(get, set, tabId, runspaceId, target.tabs.length)
})
