import { atom, type Getter, type Setter } from 'jotai'
import { atomWithDefault } from 'jotai/utils'

import type { Layout, Tab } from '../contract.ts'
import { layoutAtom, runspacesAtom, unreadOfTerminalSessionAtom } from './backend-copy.ts'
import {
  OUTSIDE,
  shownRunspaceIds,
  type TileAssignment,
  tileAssignmentAtom,
  tileKeyAt,
} from './tile-assignment.ts'
import { collapsedSectionsAtom, savedUiStateAtom, type UiState } from './ui-state.ts'

type Runspace = Layout['runspaces'][number]

export type Navigation = {
  activeRunspaceId: string | null
  activeTabIds: Readonly<Record<string, string>>
  // Runspace の Tile は repo.of を待って後から決まるので、Tile ごとではなく Runspace の id を新しい順に覚えておく。
  recentRunspaceIds: readonly string[]
  keptTile: string | null
}

export type World = {
  runspaces: Runspace[]
  tiles: TileAssignment
  unreadOf: (terminalSessionId: string) => boolean
  collapsed: ReadonlySet<string>
}

export type Entry =
  | { kind: 'row'; runspaceId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'tile'; key: string }
  | { kind: 'terminalSession'; terminalSessionId: string }
  | { kind: 'cycleRunspace'; direction: 'up' | 'down' }
  | { kind: 'cycleTab'; direction: 'left' | 'right' }
  // 閉じた後に読み直した layout には閉じた Tab の位置が無いので、閉じる前の Runspace を渡す。
  | { kind: 'tabClosed'; runspace: Runspace; tabId: string }
  | { kind: 'layout'; previous: World }
  | { kind: 'restore' }

export type Step = { state: Navigation; focusTerminal: boolean }

export function savedNavigation({
  activeRunspaceId,
  activeTabId,
  tile,
}: Pick<UiState, 'activeRunspaceId' | 'activeTabId' | 'tile'>): Navigation {
  return {
    activeRunspaceId,
    activeTabIds: activeRunspaceId && activeTabId ? { [activeRunspaceId]: activeTabId } : {},
    recentRunspaceIds: [],
    keptTile: tile,
  }
}

// active な Runspace と Tab は Workbench Ledger に持たないので、id が layout に無ければ先頭を見せる。
export function activeRunspaceOf(state: Navigation, runspaces: Runspace[]): Runspace | null {
  return runspaces.find((r) => r.id === state.activeRunspaceId) ?? runspaces[0] ?? null
}

export function activeTabOf(state: Navigation, runspace: Runspace): Tab | null {
  const id = state.activeTabIds[runspace.id]
  return runspace.tabs.find((t) => t.id === id) ?? runspace.tabs[0] ?? null
}

export function selectedTileOf(state: Navigation, world: World): string {
  const { tiles, tileKeys } = world.tiles
  const active = activeRunspaceOf(state, world.runspaces)
  const followed = active ? tileKeys[active.id] : undefined
  const tile =
    tiles.find((t) => t.key === state.keptTile) ?? tiles.find((t) => t.key === followed) ?? tiles[0]
  return tile?.key ?? OUTSIDE
}

function withoutFocus(state: Navigation): Step {
  return { state, focusTerminal: false }
}

function withFocus(state: Navigation): Step {
  return { state, focusTerminal: true }
}

function isPinned(world: World, runspaceId: string): boolean {
  return world.tiles.pinned.includes(runspaceId)
}

function keptTileOnMove(
  state: Navigation,
  { from, to }: { from: World; to: World },
  runspaceId: string,
): string | null {
  // Pinned はどの Tile を選んでも見えているので、移る前に見えていた Tile に留める。
  if (isPinned(to, runspaceId)) return selectedTileOf(state, from)
  // Repo は repo.of を待って決まるので、Tile の key を書かずに active な Runspace の Tile に従わせる。
  return null
}

// layout を読み直して移るときは、移る前に見えていた Tile を読み直す前の layout で決める。
function moveTo(
  state: Navigation,
  worlds: { from: World; to: World },
  runspaceId: string,
  tabId?: string,
): Navigation {
  const before = activeRunspaceOf(state, worlds.from.runspaces)?.id
  return {
    activeRunspaceId: runspaceId,
    activeTabIds: tabId ? { ...state.activeTabIds, [runspaceId]: tabId } : state.activeTabIds,
    // 起動時に戻した active な Runspace はここを通っていないので、離れるときに積む。
    recentRunspaceIds: [
      ...new Set([runspaceId, ...(before ? [before] : []), ...state.recentRunspaceIds]),
    ],
    keptTile: runspaceId === before ? state.keptTile : keptTileOnMove(state, worlds, runspaceId),
  }
}

function activate(state: Navigation, world: World, runspaceId: string, tabId?: string): Navigation {
  return moveTo(state, { from: world, to: world }, runspaceId, tabId)
}

// 既に active な Runspace でも、留めていた Tile からその Runspace の Tile に戻す。
function reveal(state: Navigation, world: World, runspaceId: string, tabId?: string): Navigation {
  const next = activate(state, world, runspaceId, tabId)
  return isPinned(world, runspaceId) ? next : { ...next, keptTile: null }
}

export function navigate(state: Navigation, entry: Entry, world: World): Step {
  switch (entry.kind) {
    case 'row': {
      const runspace = world.runspaces.find((r) => r.id === entry.runspaceId)
      if (!runspace) return withoutFocus(state)
      // 通知を押さずに sidebar から来ても、未読の Tab へ 1 手で着くようにする。
      const unread = runspace.tabs.find((t) => world.unreadOf(t.terminalSessionId))
      return withFocus(activate(state, world, runspace.id, unread?.id))
    }
    case 'tab': {
      const runspace = activeRunspaceOf(state, world.runspaces)
      if (!runspace?.tabs.some((t) => t.id === entry.tabId)) return withoutFocus(state)
      return withFocus(activate(state, world, runspace.id, entry.tabId))
    }
    case 'tile':
      return pressTile(state, world, entry.key)
    case 'terminalSession':
      return showTerminalSession(state, world, entry.terminalSessionId)
    case 'cycleRunspace': {
      const active = activeRunspaceOf(state, world.runspaces)?.id
      // 別の Repo の Tile へは Tile を押して移るので、巡るのは見えている行だけにする。
      const shown = shownRunspaceIds(world.tiles, selectedTileOf(state, world), world.collapsed)
      const next = cycle(shown, active, entry.direction === 'up' ? -1 : 1)
      return withoutFocus(next && next !== active ? activate(state, world, next) : state)
    }
    case 'cycleTab': {
      const runspace = activeRunspaceOf(state, world.runspaces)
      if (!runspace || runspace.tabs.length <= 1) return withoutFocus(state)
      const step = entry.direction === 'left' ? -1 : 1
      const next = cycle(runspace.tabs, activeTabOf(state, runspace), step)
      return withoutFocus(next ? activate(state, world, runspace.id, next.id) : state)
    }
    case 'tabClosed':
      return withoutFocus(closeTab(state, entry.runspace, entry.tabId))
    case 'layout':
      return withoutFocus(readLayout(state, entry.previous, world))
    case 'restore':
      return withoutFocus(restore(state, world))
  }
}

function pressTile(state: Navigation, world: World, key: string): Step {
  const underTile = (id: string | undefined): id is string =>
    id !== undefined && world.tiles.tileKeys[id] === key
  const runspaceId =
    [activeRunspaceOf(state, world.runspaces)?.id, ...state.recentRunspaceIds].find(underTile) ??
    world.runspaces.map((r) => r.id).find(underTile)
  // Runspace が無いことがあり得る Tile は「その他」だけで、端末の中身を勝手に替えないよう Tile だけを出す。
  if (!runspaceId) return withoutFocus({ ...state, keptTile: key })
  return withFocus(reveal(state, world, runspaceId))
}

function showTerminalSession(state: Navigation, world: World, terminalSessionId: string): Step {
  for (const runspace of world.runspaces) {
    const tab = runspace.tabs.find((t) => t.terminalSessionId === terminalSessionId)
    if (tab) return withFocus(reveal(state, world, runspace.id, tab.id))
  }
  return withoutFocus(state)
}

function cycle<T>(items: T[], current: T | null | undefined, step: 1 | -1): T | undefined {
  const index = current === null || current === undefined ? -1 : items.indexOf(current)
  // 畳んだ行のように一覧に無いところからは、上へ巡るときも端から始める。
  if (index === -1) return step === 1 ? items[0] : items.at(-1)
  return items[(index + step + items.length) % items.length]
}

function closeTab(state: Navigation, runspace: Runspace, tabId: string): Navigation {
  if (activeTabOf(state, runspace)?.id !== tabId) return state
  const rest = runspace.tabs.filter((t) => t.id !== tabId)
  const next =
    rest[
      Math.min(
        runspace.tabs.findIndex((t) => t.id === tabId),
        rest.length - 1,
      )
    ]
  if (!next) return state
  return { ...state, activeTabIds: { ...state.activeTabIds, [runspace.id]: next.id } }
}

// pin と pin を外す操作も、CLI の Attach で Tab が動くのも、layout の変化として届く。
function readLayout(state: Navigation, previous: World, world: World): Navigation {
  const before = activeRunspaceOf(state, previous.runspaces)
  const front = before && activeTabOf(state, before)
  // 見ていた端末が画面から消えないよう、手前の Tab はどの経路で移っても移った先までついていく。
  const moved =
    front &&
    world.runspaces.find((r) => r.id !== before.id && r.tabs.some((t) => t.id === front.id))
  if (moved) return moveTo(state, { from: previous, to: world }, moved.id, front.id)
  const after = activeRunspaceOf(state, world.runspaces)
  const wasPinned = before !== null && isPinned(previous, before.id)
  const pinned = after !== null && isPinned(world, after.id)
  // pin した Runspace はどの Tile からも抜けるので、pin した時に見えていた Tile に留める。
  if (!wasPinned && pinned) return { ...state, keptTile: selectedTileOf(state, previous) }
  // pin を外した Runspace は元の Tile に戻るので、その Tile を出して active な行を見せる。
  if (wasPinned && !pinned) return { ...state, keptTile: null }
  return state
}

function restore(state: Navigation, world: World): Navigation {
  const active = activeRunspaceOf(state, world.runspaces)
  // 留める理由の無い Tile まで戻すと、active な行が一覧に見えない状態を再起動の後へ持ち越す。
  const keep = (active !== null && isPinned(world, active.id)) || state.keptTile === OUTSIDE
  return keep ? state : { ...state, keptTile: null }
}

// 外の module は入口を通してしか書けないよう、状態の atom は export しない。
const navigationAtom = atomWithDefault((get) => savedNavigation(get(savedUiStateAtom)))

const worldAtom = atom((get): World => ({
  runspaces: get(runspacesAtom),
  tiles: get(tileAssignmentAtom),
  unreadOf: get(unreadOfTerminalSessionAtom),
  collapsed: get(collapsedSectionsAtom),
}))

export const activeRunspaceAtom = atom((get) =>
  activeRunspaceOf(get(navigationAtom), get(runspacesAtom)),
)

export const activeTabOfAtom = atom((get) => {
  const state = get(navigationAtom)
  return (runspace: Runspace) => activeTabOf(state, runspace)
})

export const activeTerminalTabAtom = atom((get) => {
  const runspace = get(activeRunspaceAtom)
  return runspace ? activeTabOf(get(navigationAtom), runspace) : null
})

export const selectedTileAtom = atom((get) => selectedTileOf(get(navigationAtom), get(worldAtom)))

export const keptTileAtom = atom((get) => get(navigationAtom).keptTile)

export const shownRunspaceIdsAtom = atom((get) => {
  const world = get(worldAtom)
  return shownRunspaceIds(world.tiles, get(selectedTileAtom), world.collapsed)
})

export const terminalFocusRequestAtom = atom(0)

function apply(get: Getter, set: Setter, entry: Entry) {
  const { state, focusTerminal } = navigate(get(navigationAtom), entry, get(worldAtom))
  set(navigationAtom, state)
  if (focusTerminal) set(terminalFocusRequestAtom, (c) => c + 1)
}

function entryAtom<Args extends unknown[]>(entryOf: (...args: Args) => Entry) {
  return atom(null, (get, set, ...args: Args) => apply(get, set, entryOf(...args)))
}

export const activateRunspaceAtom = entryAtom((runspaceId: string) => ({ kind: 'row', runspaceId }))

export const activateTerminalTabAtom = entryAtom((tabId: string) => ({ kind: 'tab', tabId }))

export const pickTileAtom = entryAtom((key: string) => ({ kind: 'tile', key }))

export const showTerminalSessionAtom = entryAtom((terminalSessionId: string) => ({
  kind: 'terminalSession',
  terminalSessionId,
}))

export const cycleRunspaceAtom = entryAtom((direction: 'up' | 'down') => ({
  kind: 'cycleRunspace',
  direction,
}))

export const cycleTerminalTabAtom = entryAtom((direction: 'left' | 'right') => ({
  kind: 'cycleTab',
  direction,
}))

export const tabClosedAtom = entryAtom((runspace: Runspace, tabId: string) => ({
  kind: 'tabClosed',
  runspace,
  tabId,
}))

export const pickTileByNumberAtom = atom(null, (get, set, n: number): boolean => {
  const key = tileKeyAt(get(tileAssignmentAtom), n)
  if (key === undefined) return false
  apply(get, set, { kind: 'tile', key })
  return true
})

// 前の layout で見えていたものと比べて選び直すので、layout を書くのと選び直すのを 1 つの書き込みにする。
export const applyLayoutAtom = atom(null, (get, set, layout: Layout) => {
  const previous = get(layoutAtom) === null ? null : get(worldAtom)
  set(layoutAtom, layout)
  apply(get, set, previous ? { kind: 'layout', previous } : { kind: 'restore' })
})
