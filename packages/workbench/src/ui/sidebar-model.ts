import type { Layout, RepoPlace, Tab } from '../contract.ts'
import { shortPath } from '../paths.ts'
import { type AgentDot, type AgentTally, tallyAgentDots } from './agent-dot.ts'
import {
  type AssignedTile,
  type BenchLabel,
  type BenchSetup,
  isCollapsed,
  OUTSIDE,
  type SectionKind,
  type TileAssignment,
} from './tile-assignment.ts'

type Runspace = Layout['runspaces'][number]

// 普通の Runspace は Tab の dot を色ごとに数えた agentTallies を、Bench は代表の Tab の agentDot を持つ。
export type RunspaceRow = {
  id: string
  isActive: boolean
  unreadCount: number
  agentTallies: AgentTally[]
  agentDot: AgentDot | null
  repo: string | null
  bench: BenchLabel | null
  title: string
  titleIsPath: boolean
  terminalTitle: string
  path: string
  branch: string | null
}

// 畳んだセクションは rows を空にし、見出しに出す行の数と未読の Tab の数だけを持つ。
export type SidebarSection = {
  kind: SectionKind
  headed: boolean
  collapsed: boolean
  rowCount: number
  unreadCount: number
  rows: RunspaceRow[]
}

export type Tile = {
  key: string
  repo: string | null
  unreadCount: number
  sections: SidebarSection[]
}

export type Sidebar = {
  pinned: RunspaceRow[]
  tiles: Tile[]
  selected: Tile
}

export type SidebarInput = {
  runspaces: Runspace[]
  assignment: TileAssignment
  selectedTile: string
  activeRunspaceId: string | null
  activeTabOf: (runspace: Runspace) => Tab | null
  titles: Record<string, string>
  places: Record<string, RepoPlace | undefined>
  unreadOf: (terminalSessionId: string) => boolean
  agentDotOf: (terminalSessionId: string) => AgentDot | null
  collapsed: ReadonlySet<string>
}

export function isPathTitle(title: string): boolean {
  return title === '~' || title.startsWith('~/') || title.startsWith('/')
}

export function repoName(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1)
}

// Repo は Backend への問い合わせを待って決まるので、引けるまでは cwd の末尾で出す。
function pathOf(cwd: string, place: RepoPlace | undefined): string {
  return place?.path ?? shortPath(cwd)
}

// 動いている claude を手空きで隠さないよう、Task の表示状態の集約（手空き > 未観測 > 動作中）とは違う順で選ぶ。
const REPRESENTATIVE_RANK: Record<AgentDot, number> = {
  question: 0,
  permission: 0,
  error: 1,
  running: 2,
  idle: 3,
  unobserved: 4,
}

// 同じ順位なら左の Tab を選び、Tab の並びと合わせて行の端末の title が飛び回らないようにする。
function representativeOf(
  input: SidebarInput,
  runspace: Runspace,
): { tab: Tab; dot: AgentDot } | null {
  let chosen: { tab: Tab; dot: AgentDot } | null = null
  for (const tab of runspace.tabs) {
    const dot = input.agentDotOf(tab.terminalSessionId)
    if (dot && (!chosen || REPRESENTATIVE_RANK[dot] < REPRESENTATIVE_RANK[chosen.dot])) {
      chosen = { tab, dot }
    }
  }
  return chosen
}

function runspaceRow(input: SidebarInput, runspace: Runspace): RunspaceRow {
  const assigned = input.assignment.runspaces[runspace.id]
  const bench = assigned?.bench ?? null
  const tab = input.activeTabOf(runspace)
  const representative = bench ? representativeOf(input, runspace) : null
  const titleTab = representative?.tab ?? tab
  const cwd = tab?.cwd ?? runspace.cwd
  const raw = (titleTab && input.titles[titleTab.id]) ?? ''
  const terminalTitle = isPathTitle(raw) ? '' : raw
  const place = input.places[cwd]
  const path = pathOf(cwd, place)
  return {
    id: runspace.id,
    isActive: runspace.id === input.activeRunspaceId,
    unreadCount: runspace.tabs.filter((t) => input.unreadOf(t.terminalSessionId)).length,
    agentTallies: bench
      ? []
      : tallyAgentDots(runspace.tabs.map((t) => input.agentDotOf(t.terminalSessionId))),
    agentDot: representative?.dot ?? null,
    repo: assigned?.repo ?? null,
    bench,
    title: bench?.title || terminalTitle || path,
    titleIsPath: !bench && !terminalTitle,
    terminalTitle,
    path,
    branch: place?.branch ?? null,
  }
}

function sum(items: { unreadCount: number }[]): number {
  return items.reduce((total, item) => total + item.unreadCount, 0)
}

function tileOf(
  input: SidebarInput,
  tile: AssignedTile,
  rowsOf: (ids: string[]) => RunspaceRow[],
): Tile {
  const sections = tile.sections.map((section): SidebarSection => {
    const rows = rowsOf(section.runspaceIds)
    const collapsed = isCollapsed(tile, section.kind, input.collapsed)
    return {
      kind: section.kind,
      headed: tile.sections.length > 1,
      collapsed,
      rowCount: rows.length,
      unreadCount: sum(rows),
      rows: collapsed ? [] : rows,
    }
  })
  return { key: tile.key, repo: tile.repo, unreadCount: sum(sections), sections }
}

const EMPTY_OUTSIDE_TILE: Tile = { key: OUTSIDE, repo: null, unreadCount: 0, sections: [] }

export function buildSidebar(input: SidebarInput): Sidebar {
  const rows = new Map(input.runspaces.map((r) => [r.id, runspaceRow(input, r)]))
  const rowsOf = (ids: string[]) => ids.flatMap((id) => rows.get(id) ?? [])
  const tiles = input.assignment.tiles.map((tile) => tileOf(input, tile, rowsOf))
  return {
    pinned: rowsOf(input.assignment.pinned),
    tiles,
    selected: tiles.find((tile) => tile.key === input.selectedTile) ?? EMPTY_OUTSIDE_TILE,
  }
}

// Workbench Ledger の並びは 1 本なので、並べ替えは同じセクションの中に限る。
export function sectionPeersOf(sidebar: Sidebar, runspaceId: string): string[] {
  const groups = [
    sidebar.pinned,
    ...sidebar.tiles.flatMap((tile) => tile.sections.map((s) => s.rows)),
  ]
  return groups.find((rows) => rows.some((r) => r.id === runspaceId))?.map((r) => r.id) ?? []
}

export type ListedIn = 'pinned' | 'repo' | 'outside'

export type RowMeta = {
  setup: BenchSetup | null
  tallies: AgentTally[]
  dot: AgentDot | null
  info: string
  infoMono: boolean
  chip: string | null
  where: string
  whereMono: boolean
}

export function rowMetaOf(row: RunspaceRow, listedIn: ListedIn): RowMeta | null {
  const setup = row.bench?.setup ?? null
  const tallies = row.agentTallies
  const dot = row.agentDot
  const info = row.bench ? row.terminalTitle : (row.branch ?? '')
  let chip: string | null = null
  let where = ''
  if (listedIn === 'pinned' && row.repo) {
    chip = row.repo
    where = repoName(row.repo) + (row.bench ? `#${row.bench.number}` : '')
  } else if (row.bench) {
    where = `#${row.bench.number}`
  } else if (listedIn !== 'repo' && !row.titleIsPath) {
    where = row.path
  }
  if (!setup && tallies.length === 0 && !dot && !info && !where) return null
  return {
    setup,
    tallies,
    dot,
    info,
    infoMono: !row.bench,
    chip,
    where,
    whereMono: Boolean(row.bench) || !row.repo,
  }
}
