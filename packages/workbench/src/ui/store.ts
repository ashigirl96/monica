import { type PopoverAnchor, pushErrorToast, pushInfoToast } from '@monica/ui'
import type { ContractRouterClient } from '@orpc/contract'
import { atom, type Getter, type Setter, type Store } from 'jotai'
import { atomWithDefault } from 'jotai/utils'

import type { contract, Layout, ListedAgentSession, RepoPlace, Tab } from '../contract.ts'
import { agentDotOf } from './agent-dot.ts'
import { jumpHintsActiveAtom, pendingCloseTabIdAtom } from './jump-hints.ts'
import {
  type BenchLabelOf,
  buildSidebar,
  isPathTitle,
  OUTSIDE,
  sectionPeersOf,
  shownRunspaceIds,
  type Sidebar,
  tileAt,
} from './sidebar-model.ts'
import { getTabTerminal, releaseTabConnection } from './terminal-connections.ts'
import {
  applyTerminalSessionListAtom,
  isDeadStatus,
  markEndedAtom,
  setTerminalSessionStatusAtom,
  type TerminalSessionStatusEntry,
  terminalSessionStatusAtom,
} from './terminal-sessions.ts'
import { collapsedSectionsAtom, savedUiStateAtom, tileChoiceAtom } from './ui-state.ts'

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

// Runspace の Tile は repo.of を待って後から決まるので、Tile ごとではなく Runspace の id を新しい順に覚えておく。
const recentRunspaceIdsAtom = atom<string[]>([])

type Activation = {
  runspaceId: string
  tabId?: string
  // 既に active な Runspace でも、覗いている Tile からその Runspace の Tile に戻す。
  revealTile?: boolean
}

// 切り替えはすべてここを通るので、jump hint を閉じるのも、選んだ Tile を active な Runspace の Tile に合わせるのもここで行う。
const setActiveAtom = atom(null, (get, set, next: Activation) => {
  const before = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id]
  // layout が入れ替わった直後は、消えた Runspace の代わりに先頭が active に見えるので、選んでいた id と比べる。
  const chosenBefore = get(activeRunspaceIdAtom)
  const shownTile = get(sidebarAtom).selected.key
  set(activeRunspaceIdAtom, next.runspaceId)
  // 起動時に戻した active な Runspace はここを通っていないので、離れるときに積む。
  set(recentRunspaceIdsAtom, (prev) => [
    ...new Set([next.runspaceId, ...(before[0] ? [before[0]] : []), ...prev]),
  ])
  const { tabId } = next
  if (tabId) set(activeTabIdsAtom, (prev) => ({ ...prev, [next.runspaceId]: tabId }))
  const after = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id]
  if (before[0] !== after[0] || before[1] !== after[1]) set(jumpHintsActiveAtom, false)
  if (!after[0] || (chosenBefore === next.runspaceId && !next.revealTile)) return
  // Repo は repo.of を待って決まるので、Tile の key を書かずに active な Runspace に従わせる。
  // Pinned はどの Tile を選んでも見えているので、そのとき見えていた Tile に留める。
  set(tileChoiceAtom, after[0] in get(sidebarAtom).tileKeys ? null : shownTile)
})

// 通知を押さずに sidebar から来ても、未読の Tab へ 1 手で着くようにする。
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

export const showTerminalSessionAtom = atom(null, (get, set, terminalSessionId: string) => {
  for (const runspace of get(layoutAtom)?.runspaces ?? []) {
    const tab = runspace.tabs.find((t) => t.terminalSessionId === terminalSessionId)
    if (!tab) continue
    set(setActiveAtom, { runspaceId: runspace.id, tabId: tab.id, revealTile: true })
    set(terminalFocusRequestAtom, (c) => c + 1)
    return
  }
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

// cwds を省けば、layout の Runspace と Tab の cwd を引き直す。
const resolvePlacesAtom = atom(null, async (get, set, cwds?: string[]) => {
  const checkedAt = get(placesCheckedAtAtom)
  const now = Date.now()
  const candidates =
    cwds ?? (get(layoutAtom)?.runspaces ?? []).flatMap((r) => [r.cwd, ...r.tabs.map((t) => t.cwd)])
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
    agentDotOf: get(agentDotOfTerminalSessionAtom),
    benchLabelOf: get(benchLabelOfAtom) ?? (() => null),
    tileChoice: get(tileChoiceAtom),
    collapsed: get(collapsedSectionsAtom),
  }),
)

export const pickTileAtom = atom(null, (get, set, key: string) => {
  const { tileKeys } = get(sidebarAtom)
  const underTile = (id: string | undefined): id is string =>
    id !== undefined && tileKeys[id] === key
  const runspaceId =
    [get(activeRunspaceAtom)?.id, ...get(recentRunspaceIdsAtom)].find(underTile) ??
    get(layoutAtom)
      ?.runspaces.map((r) => r.id)
      .find(underTile)
  if (!runspaceId) {
    set(tileChoiceAtom, key)
    return
  }
  set(setActiveAtom, { runspaceId })
  set(terminalFocusRequestAtom, (c) => c + 1)
  // 開いた Runspace が既に active でも、覗いていた Tile から戻すために従わせ直す。
  set(tileChoiceAtom, null)
})

export const pickTileByNumberAtom = atom(null, (get, set, n: number): boolean => {
  const tile = tileAt(get(sidebarAtom), n)
  if (!tile) return false
  set(pickTileAtom, tile.key)
  return true
})

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

// Terminal Session の終了は Backend が tab.close の transaction の後に予約するので、webview からは頼まない（ADR-0023）。
async function closeTab(get: Getter, set: Setter, { runspace, tab }: TabInRunspace) {
  // 空になったかは close の transaction で決まる。読み直した layout では、間に Tab を外へ移した分と区別できない。
  let emptiedRunspaceId: string | null = null
  try {
    emptiedRunspaceId = (await clientOf(get).tab.close({ id: tab.id })).emptiedRunspaceId
  } catch (e) {
    if (!isGone(e)) throw e
  }
  releaseTabConnection(tab.id)
  if (activeTabOf(get, runspace)?.id === tab.id) {
    const rest = runspace.tabs.filter((t) => t.id !== tab.id)
    const next = rest[Math.min(runspace.tabs.indexOf(tab), rest.length - 1)]
    if (next) set(activeTabIdsAtom, (prev) => ({ ...prev, [runspace.id]: next.id }))
  }
  await set(reloadAtom)
  if (!emptiedRunspaceId) return
  await untilExitRecorded(get, tab.terminalSessionId)
  get(lastTabClosedAtom)?.(emptiedRunspaceId)
}

export const closeTerminalTabAtom = action(async (get, set, tabId?: string) => {
  const found = tabId ? findTab(get, tabId) : frontTab(get)
  if (found) await closeTab(get, set, found)
})

// webview の一覧は合図の後に読み直すまで古く、起動の直後は空なので、閉じる前に Backend に聞く。
async function hasLiveAgentSession(get: Getter, terminalSessionId: string): Promise<boolean> {
  const listed = await clientOf(get).agentSession.list()
  return listed.some((a) => a.terminalSessionId === terminalSessionId)
}

// d は c（新しい Tab）の隣のキーなので、claude の居る Tab は打ち損じで消さないよう 2 度目の d を待つ。
export const closeTabFromJumpModeAtom = action(async (get, set) => {
  const front = frontTab(get)
  const pending = get(pendingCloseTabIdAtom)
  // 尋ねた Tab が shell の終了で先に閉じたら、手前に来た別の Tab は誰も確かめていない。
  if (!front || front.tab.pinned || (pending !== null && pending !== front.tab.id)) {
    set(jumpHintsActiveAtom, false)
    return
  }
  if (pending !== front.tab.id) {
    const live = await hasLiveAgentSession(get, front.tab.terminalSessionId)
    // 聞く間にほかのキーや Tab の切り替えで jump モードを抜けていたら、その操作を優先する。
    if (!get(jumpHintsActiveAtom)) return
    if (live) {
      set(pendingCloseTabIdAtom, front.tab.id)
      return
    }
  }
  set(jumpHintsActiveAtom, false)
  await set(closeTerminalTabAtom, front.tab.id)
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
      await closeTab(get, set, found)
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
  // pin した Runspace はどの Tile からも抜け、選んだ Tile が従う先を失うので、見えていた Tile に留める。
  if (!pinned) set(tileChoiceAtom, get(sidebarAtom).selected.key)
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

export type TabMenuState = {
  tabId: string
  anchor: PopoverAnchor
}

export const tabMenuAtom = atom<TabMenuState | null>(null)

export const tabMenuTabAtom = atom((get) => {
  const menu = get(tabMenuAtom)
  return menu ? (findTab(get, menu.tabId)?.tab ?? null) : null
})

function cycle<T>(items: T[], current: T | null | undefined, step: 1 | -1): T | undefined {
  const index = current === null || current === undefined ? -1 : items.indexOf(current)
  // 畳んだ行のように一覧に無いところからは、上へ巡るときも端から始める。
  if (index === -1) return step === 1 ? items[0] : items.at(-1)
  return items[(index + step + items.length) % items.length]
}

// 別の Repo の Tile へは ⌘ の数字で移るので、巡るのは見えている行だけにする。
export const cycleRunspaceAtom = atom(null, (get, set, direction: 'up' | 'down') => {
  const active = get(activeRunspaceAtom)?.id
  const next = cycle(shownRunspaceIds(get(sidebarAtom)), active, direction === 'up' ? -1 : 1)
  if (next && next !== active) set(setActiveAtom, { runspaceId: next })
})

export const cycleTerminalTabAtom = atom(null, (get, set, direction: 'left' | 'right') => {
  const runspace = get(activeRunspaceAtom)
  if (!runspace || runspace.tabs.length <= 1) return
  const next = cycle(runspace.tabs, activeTabOf(get, runspace), direction === 'left' ? -1 : 1)
  if (next) set(setActiveAtom, { runspaceId: runspace.id, tabId: next.id })
})

// Tile とセクションは Workbench Ledger の並びより先に効くので、セクションをまたいで動かしても見た目の位置にならない。
async function moveRunspace(get: Getter, set: Setter, id: string, index: number) {
  await clientOf(get).runspace.move({ id, index })
  await set(reloadAtom)
}

async function moveRunspaceTo(get: Getter, set: Setter, id: string, toId: string) {
  if (!sectionPeersOf(get(sidebarAtom), id).includes(toId)) return
  const index = (get(layoutAtom)?.runspaces ?? []).findIndex((r) => r.id === toId)
  await moveRunspace(get, set, id, index)
}

async function moveTab(get: Getter, set: Setter, id: string, runspaceId: string, index: number) {
  await clientOf(get).tab.move({ id, runspaceId, index })
  await set(reloadAtom)
}

export const reorderRunspacesAtom = action(moveRunspaceTo)

const moveRunspaceToEndAtom = atom(null, (get, set, id: string) =>
  moveRunspace(get, set, id, (get(layoutAtom)?.runspaces.length ?? 0) - 1),
)

// Tile の順も Tile の中の行の順も Workbench Ledger の並びで決まるので、別の Repo に入った Runspace は末尾へ送って一番下に出す。
export function appendRunspacesJoiningTile(store: Store): () => void {
  // まだどの Repo にも入っていない Runspace は OUTSIDE を持つ。
  const lastTileKeys: Record<string, string> = {}
  const check = () => {
    const { cwdTileKeys } = store.get(sidebarAtom)
    const joined: string[] = []
    for (const [id, key] of Object.entries(cwdTileKeys)) {
      // Repo の外への出入りでも動かすと、cd ~ して戻るだけで drag で並べた位置が崩れる。
      if (key === OUTSIDE) {
        lastTileKeys[id] ??= OUTSIDE
        continue
      }
      // Repo が初めて引けたときに動かすと、起動のたびに並びが崩れる。
      if (id in lastTileKeys && lastTileKeys[id] !== key) joined.push(id)
      lastTileKeys[id] = key
    }
    for (const id of joined) {
      store.set(moveRunspaceToEndAtom, id).catch((e: unknown) => {
        if (!isGone(e)) warnFailed('runspace move', e)
      })
    }
  }
  check()
  return store.sub(sidebarAtom, check)
}

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
  // Tile の順はセクションの先頭の行の位置で決まるので、後ろの行を前の行の位置へ動かし、前の位置を保つ。
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
