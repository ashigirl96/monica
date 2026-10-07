import type { Layout, RepoPlace, Tab, TerminalSession } from '../contract.ts'
import { shortPath } from '../paths.ts'

type Runspace = Layout['runspaces'][number]

// Repo の札の key は owner/repo で必ず `/` を含むので、`/` の無い語は Repo と重ならない。
export const OUTSIDE = 'outside'

export type BenchNote = { text: string; error: boolean }

// workbench は Task を知らないので、Bench の Task の Repo と Issue は task の ui から slot で受ける（ADR-0005）。
export type BenchLabel = {
  repo: string
  number: number
  title: string
  note: BenchNote | null
}

export type BenchLabelOf = (runspaceId: string) => BenchLabel | null

export type RunspaceRow = {
  type: 'runspace'
  id: string
  isActive: boolean
  unreadCount: number
  repo: string | null
  bench: BenchLabel | null
  title: string
  titleIsPath: boolean
  terminalTitle: string
  path: string
  branch: string | null
}

export type DetachedRow = {
  type: 'detached'
  id: string
  terminalSession: TerminalSession
  unreadCount: number
  repo: string | null
  path: string
}

export type SidebarRow = RunspaceRow | DetachedRow

export type SectionKind = 'bench' | 'runspaces' | 'detached'

// 畳んだセクションは rows を空にし、見出しに出す行の数と未読の Tab の数だけを持つ。
export type SidebarSection = {
  kind: SectionKind
  headed: boolean
  collapsed: boolean
  rowCount: number
  unreadCount: number
  rows: SidebarRow[]
}

export type Rail = {
  key: string
  repo: string | null
  unreadCount: number
  sections: SidebarSection[]
}

// railKeys は Pinned でない Runspace ごとの札で、畳んだセクションの行も含む。
export type Sidebar = {
  pinned: RunspaceRow[]
  rails: Rail[]
  selected: Rail
  railKeys: Record<string, string>
}

export type SidebarInput = {
  runspaces: Runspace[]
  activeRunspaceId: string | null
  activeTabOf: (runspace: Runspace) => Tab | null
  titles: Record<string, string>
  places: Record<string, RepoPlace | undefined>
  unreadOf: (terminalSessionId: string) => boolean
  benchLabelOf: BenchLabelOf
  detached: TerminalSession[]
  railChoice: string | null
  collapsed: ReadonlySet<string>
}

// Claude Code が title の頭に付ける spinner は動作中の印で、Agent の状態は Tab の dot が出す。
const SPINNER = /^[·✢✳✶✻✽]\s*/

export function isPathTitle(title: string): boolean {
  return title === '~' || title.startsWith('~/') || title.startsWith('/')
}

export function sectionKey(railKey: string, kind: SectionKind): string {
  return `${railKey}:${kind}`
}

export function repoName(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1)
}

// Repo は Backend への問い合わせを待って決まるので、引けるまでは cwd の末尾で出す。
function pathOf(cwd: string, place: RepoPlace | undefined): string {
  return place?.path ?? shortPath(cwd)
}

function holdsPin(runspace: Runspace): boolean {
  return runspace.tabs.some((t) => t.pinned)
}

function runspaceRow(input: SidebarInput, runspace: Runspace): RunspaceRow {
  const bench = runspace.owned ? input.benchLabelOf(runspace.id) : null
  // 一番左の Tab で決めるので、Tab を切り替えても行は別の札へ移らない。
  const leftmost = runspace.tabs[0]?.cwd ?? runspace.cwd
  const tab = input.activeTabOf(runspace)
  const cwd = tab?.cwd ?? runspace.cwd
  const plain = (tab && input.titles[tab.id]?.replace(SPINNER, '')) ?? ''
  const terminalTitle = isPathTitle(plain) ? '' : plain
  const place = input.places[cwd]
  const path = pathOf(cwd, place)
  return {
    type: 'runspace',
    id: runspace.id,
    isActive: runspace.id === input.activeRunspaceId,
    unreadCount: runspace.tabs.filter((t) => input.unreadOf(t.terminalSessionId)).length,
    repo: bench?.repo ?? input.places[leftmost]?.repo ?? null,
    bench,
    title: bench?.title || terminalTitle || path,
    titleIsPath: !bench && !terminalTitle,
    terminalTitle,
    path,
    branch: place?.branch ?? null,
  }
}

function detachedRow(input: SidebarInput, terminalSession: TerminalSession): DetachedRow {
  const place = input.places[terminalSession.cwd]
  return {
    type: 'detached',
    id: terminalSession.id,
    terminalSession,
    unreadCount: input.unreadOf(terminalSession.id) ? 1 : 0,
    repo: place?.repo ?? null,
    path: pathOf(terminalSession.cwd, place),
  }
}

function sum(items: { unreadCount: number }[]): number {
  return items.reduce((total, item) => total + item.unreadCount, 0)
}

function railOf(input: SidebarInput, key: string, rows: SidebarRow[]): Rail {
  const isBench = (row: SidebarRow) => row.type === 'runspace' && row.bench !== null
  const parts = [
    { kind: 'bench' as const, rows: rows.filter(isBench) },
    { kind: 'runspaces' as const, rows: rows.filter((r) => r.type === 'runspace' && !isBench(r)) },
    { kind: 'detached' as const, rows: rows.filter((r) => r.type === 'detached') },
  ].filter((part) => part.rows.length > 0)
  // セクションが 1 つなら見出しを出さないので、畳んだままでも行を隠さない。
  const headed = parts.length > 1
  const sections = parts.map((part): SidebarSection => {
    const collapsed = headed && input.collapsed.has(sectionKey(key, part.kind))
    return {
      kind: part.kind,
      headed,
      collapsed,
      rowCount: part.rows.length,
      unreadCount: sum(part.rows),
      rows: collapsed ? [] : part.rows,
    }
  })
  const repo = key === OUTSIDE ? null : (rows[0]?.repo ?? key)
  return { key, repo, unreadCount: sum(sections), sections }
}

export function buildSidebar(input: SidebarInput): Sidebar {
  const runspaces = input.runspaces.map((runspace) => ({
    row: runspaceRow(input, runspace),
    pinned: holdsPin(runspace),
  }))
  const listed: SidebarRow[] = [
    ...runspaces.filter((r) => !r.pinned).map((r) => r.row),
    ...input.detached.map((s) => detachedRow(input, s)),
  ]
  // GitHub の Repo 名は大小文字を区別しないので、Task の nameWithOwner と checkout の path が違っても同じ札にする。
  const railKey = (row: SidebarRow) => row.repo?.toLowerCase() ?? OUTSIDE
  const keys = new Set(listed.map(railKey))
  keys.delete(OUTSIDE)
  const rails = [...keys, OUTSIDE].map((key) =>
    railOf(
      input,
      key,
      listed.filter((r) => railKey(r) === key),
    ),
  )
  const railKeys = Object.fromEntries(
    listed.filter((r) => r.type === 'runspace').map((r) => [r.id, railKey(r)]),
  )
  const active = input.activeRunspaceId && railKeys[input.activeRunspaceId]
  const selected =
    rails.find((r) => r.key === input.railChoice) ??
    rails.find((r) => r.key === active) ??
    rails[0]!
  return { pinned: runspaces.filter((r) => r.pinned).map((r) => r.row), rails, selected, railKeys }
}

function runspaceRowsOf(rows: SidebarRow[]): RunspaceRow[] {
  return rows.filter((row): row is RunspaceRow => row.type === 'runspace')
}

function shownRunspaceRowsOf(rail: Rail): RunspaceRow[] {
  return rail.sections.flatMap((s) => runspaceRowsOf(s.rows))
}

export function shownRunspaceIds(sidebar: Sidebar): string[] {
  return [...sidebar.pinned, ...shownRunspaceRowsOf(sidebar.selected)].map((r) => r.id)
}

export function cycledRunspaceIds(sidebar: Sidebar): string[] {
  return [...sidebar.pinned, ...sidebar.rails.flatMap(shownRunspaceRowsOf)].map((r) => r.id)
}

// Workbench Ledger の並びは 1 本なので、並べ替えは同じセクションの中に限る。
export function sectionPeersOf(sidebar: Sidebar, runspaceId: string): string[] {
  const groups = [
    sidebar.pinned,
    ...sidebar.rails.flatMap((rail) => rail.sections.map((s) => runspaceRowsOf(s.rows))),
  ]
  return groups.find((rows) => rows.some((r) => r.id === runspaceId))?.map((r) => r.id) ?? []
}

export type ListedIn = 'pinned' | 'repo' | 'outside'

export type RowMeta = {
  note: BenchNote | null
  info: string
  infoMono: boolean
  chip: string | null
  where: string
  whereMono: boolean
}

export function rowMetaOf(row: RunspaceRow, listedIn: ListedIn): RowMeta | null {
  const note = row.bench?.note ?? null
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
  if (!note && !info && !where) return null
  return {
    note,
    info,
    infoMono: !row.bench,
    chip,
    where,
    whereMono: Boolean(row.bench) || !row.repo,
  }
}
