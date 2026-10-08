import { atom } from 'jotai'

import type { Layout, RepoPlace } from '../contract.ts'
import { placesAtom, runspacesAtom } from './backend-copy.ts'

type Runspace = Layout['runspaces'][number]

// Repo の Tile の key は owner/repo で必ず `/` を含むので、`/` の無い語は Repo と重ならない。
export const OUTSIDE = 'outside'

export type BenchSetup = { text: string; error: boolean }

// workbench は Task を知らないので、Bench の Task の Repo と Issue は task の ui から slot で受ける（ADR-0005）。
export type BenchLabel = {
  repo: string
  number: number
  title: string
  setup: BenchSetup | null
}

export type BenchLabelOf = (runspaceId: string) => BenchLabel | null

export type SectionKind = 'bench' | 'runspaces'

export type AssignedSection = { kind: SectionKind; runspaceIds: string[] }

export type AssignedTile = {
  key: string
  repo: string | null
  sections: AssignedSection[]
}

// cwdTileKeys は、Tile を移ったら並びの末尾へ動かす Runspace（Task が持たず、cwd から Repo が引けたもの）に限る。
export type TileAssignment = {
  runspaces: Record<string, { bench: BenchLabel | null; repo: string | null }>
  pinned: string[]
  tiles: AssignedTile[]
  tileKeys: Record<string, string>
  cwdTileKeys: Record<string, string>
}

export type TileAssignmentInput = {
  runspaces: Runspace[]
  places: Record<string, RepoPlace | undefined>
  benchLabelOf: BenchLabelOf
}

function holdsPin(runspace: Runspace): boolean {
  return runspace.tabs.some((t) => t.pinned)
}

// 一番左の Tab で決めるので、Tab を切り替えても行は別の Tile へ移らない。
function leftmostCwd(runspace: Runspace): string {
  return runspace.tabs[0]?.cwd ?? runspace.cwd
}

export function assignTiles(input: TileAssignmentInput): TileAssignment {
  const entries = input.runspaces.map((runspace) => {
    const bench = runspace.owned ? input.benchLabelOf(runspace.id) : null
    const repo = bench?.repo ?? input.places[leftmostCwd(runspace)]?.repo ?? null
    // GitHub の Repo 名は大小文字を区別しないので、Task の nameWithOwner と checkout の path が違っても同じ Tile にする。
    return { runspace, bench, repo, key: repo?.toLowerCase() ?? OUTSIDE }
  })
  const listed = entries.filter((e) => !holdsPin(e.runspace))
  const keys = new Set(listed.map((e) => e.key))
  keys.delete(OUTSIDE)
  const tiles = [...keys, OUTSIDE].map((key): AssignedTile => {
    const under = listed.filter((e) => e.key === key)
    const sections = [
      {
        kind: 'bench' as const,
        runspaceIds: under.filter((e) => e.bench).map((e) => e.runspace.id),
      },
      {
        kind: 'runspaces' as const,
        runspaceIds: under.filter((e) => !e.bench).map((e) => e.runspace.id),
      },
    ].filter((section) => section.runspaceIds.length > 0)
    return { key, repo: key === OUTSIDE ? null : (under[0]?.repo ?? key), sections }
  })
  return {
    runspaces: Object.fromEntries(
      entries.map((e) => [e.runspace.id, { bench: e.bench, repo: e.repo }]),
    ),
    pinned: entries.filter((e) => holdsPin(e.runspace)).map((e) => e.runspace.id),
    tiles,
    tileKeys: Object.fromEntries(listed.map((e) => [e.runspace.id, e.key])),
    cwdTileKeys: Object.fromEntries(
      listed
        .filter((e) => !e.runspace.owned && input.places[leftmostCwd(e.runspace)])
        .map((e) => [e.runspace.id, e.key]),
    ),
  }
}

export const benchLabelOfAtom = atom<BenchLabelOf | null>(null)

export const tileAssignmentAtom = atom((get) =>
  assignTiles({
    runspaces: get(runspacesAtom),
    places: get(placesAtom),
    benchLabelOf: get(benchLabelOfAtom) ?? (() => null),
  }),
)

export function sectionKey(tileKey: string, kind: SectionKind): string {
  return `${tileKey}:${kind}`
}

// セクションが 1 つなら見出しを出さないので、畳んだままでも行を隠さない。
export function isCollapsed(
  tile: AssignedTile,
  kind: SectionKind,
  collapsed: ReadonlySet<string>,
): boolean {
  return tile.sections.length > 1 && collapsed.has(sectionKey(tile.key, kind))
}

export function shownRunspaceIds(
  assignment: TileAssignment,
  tileKey: string,
  collapsed: ReadonlySet<string>,
): string[] {
  const tile = assignment.tiles.find((t) => t.key === tileKey)
  const open = tile ? tile.sections.filter((s) => !isCollapsed(tile, s.kind, collapsed)) : []
  return [...assignment.pinned, ...open.flatMap((s) => s.runspaceIds)]
}

type TileOrder = { tiles: readonly { key: string }[] }

// Repo の外の Tile は常に最後にある。
export function tileNumberOf({ tiles }: TileOrder, key: string): number | null {
  if (key === OUTSIDE) return 0
  const n = tiles.findIndex((tile) => tile.key === key) + 1
  return n >= 1 && n <= 9 ? n : null
}

export function tileKeyAt(order: TileOrder, n: number): string | undefined {
  return order.tiles.find((tile) => tileNumberOf(order, tile.key) === n)?.key
}
