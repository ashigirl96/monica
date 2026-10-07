import { ChevronRightIcon, cn, FolderIcon, PinIcon, useDragReorder } from '@tania/ui'
import { useAtomValue, useSetAtom } from 'jotai'
import { type MouseEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react'

import { AgentDotMark, AgentTallyMark } from './agent-dot-mark.tsx'
import { AGENT_DOT_STYLE, agentTallyLabel, UNREAD_LABEL_STYLE } from './agent-dot.ts'
import { JumpHint } from './jump-hint.tsx'
import { jumpHintTargetsAtom } from './jump-hints.ts'
import { metaHeldAtom } from './meta-hold.ts'
import {
  type ListedIn,
  repoName,
  type RowMeta,
  rowMetaOf,
  type RunspaceRow,
  sectionKey,
  type SidebarSection,
  type Tile,
  tileNumberOf,
} from './sidebar-model.ts'
import {
  activateRunspaceAtom,
  draggedTabIdAtom,
  moveTabToRunspaceAtom,
  pickTileAtom,
  reorderRunspacesAtom,
  sidebarAtom,
  toggleSectionAtom,
} from './store.ts'

const OUTSIDE_LABEL = 'その他'

const SECTION_LABELS: Record<SidebarSection['kind'], string> = {
  bench: 'Bench',
  runspaces: 'Runspaces',
}

// Tile の色は dot の緑・琥珀・赤・灰と紛れない色から、repo ごとに決まった 1 つを選ぶ。
const TILE_HUES = [
  { bg: 'rgba(56,189,248,.2)', fg: '#7dd3fc' },
  { bg: 'rgba(167,139,250,.22)', fg: '#c4b5fd' },
  { bg: 'rgba(244,114,182,.2)', fg: '#f9a8d4' },
  { bg: 'rgba(192,132,252,.2)', fg: '#d8b4fe' },
  { bg: 'rgba(99,102,241,.28)', fg: '#a5b4fc' },
  { bg: 'rgba(34,211,238,.18)', fg: '#67e8f9' },
  { bg: 'rgba(232,121,249,.2)', fg: '#f0abfc' },
  { bg: 'rgba(96,165,250,.2)', fg: '#93c5fd' },
]

function hueOf(repo: string) {
  let hash = 0
  for (const char of repo.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TILE_HUES[hash % TILE_HUES.length]!
}

function withUnread(label: string, count: number): string {
  return count > 0 ? `${label}、未読の Tab ${count}` : label
}

function rowLabel(title: string, meta: RowMeta | null, unreadCount: number): string {
  const agent = meta
    ? [...meta.tallies.map(agentTallyLabel), ...(meta.dot ? [AGENT_DOT_STYLE[meta.dot].label] : [])]
    : []
  return withUnread([title, ...agent].join('、'), unreadCount)
}

// WKWebView は trackpad の tap を up、down の順で届け、click は 1 つ前の tap の down と組んで共通の祖先に飛ぶので、押した要素に届く mousedown で動かす。
function pressHandlers(action: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      // 押した後に focus を戻すと xterm が DECSET 1004 を立てた app に focus out と in を送るので、既定の動作を止めて端末から focus を外さない。
      e.preventDefault()
      if (e.button === 0) action()
    },
    onClick: (e: MouseEvent) => {
      const fromKeyboard = e.detail === 0
      if (fromKeyboard) action()
    },
  }
}

function UnreadCount({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-zinc-100 px-1 text-[9.5px] leading-none font-bold text-zinc-900',
        className,
      )}
    >
      {count}
    </span>
  )
}

function TileButton({
  tile,
  number,
  selected,
  onPick,
}: {
  tile: Tile
  number: number | null
  selected: boolean
  onPick: () => void
}) {
  const label = tile.repo ?? OUTSIDE_LABEL
  const hue = tile.repo ? hueOf(tile.repo) : null
  const metaHeld = useAtomValue(metaHeldAtom)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      {metaHeld && tile.repo && (
        <TileName anchor={button} label={repoName(tile.repo)} number={number} />
      )}
      <button
        ref={button}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={withUnread(label, tile.unreadCount)}
        aria-keyshortcuts={number === null ? undefined : `Meta+${number}`}
        title={number === null ? label : `${label} (⌘${number})`}
        {...pressHandlers(onPick)}
        className={cn(
          'relative flex size-[30px] shrink-0 items-center justify-center text-xs leading-none font-bold',
          'transition-[border-radius,filter] duration-150 hover:brightness-125 motion-reduce:transition-none',
          'focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-white/50',
          selected ? 'rounded-[7px] ring-[1.5px] ring-white/55' : 'rounded-[9px]',
          !hue && 'bg-white/[0.08] text-white/75',
        )}
        style={hue ? { background: hue.bg, color: hue.fg } : undefined}
      >
        {tile.repo ? (
          repoName(tile.repo).charAt(0).toUpperCase()
        ) : (
          <FolderIcon size={14} strokeWidth={2} />
        )}
        <UnreadCount
          count={tile.unreadCount}
          className="absolute -top-[5px] -right-[7px] ring-2 ring-zinc-900"
        />
      </button>
    </>
  )
}

// Rail は縦に scroll する箱で横にはみ出した分が切れるので、名前は fixed で箱から出し、描く前に Tile の右上へ合わせる。
function TileName({
  anchor,
  label,
  number,
}: {
  anchor: RefObject<HTMLButtonElement | null>
  label: string
  number: number | null
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect || !ref.current) return
    ref.current.style.left = `${rect.right - 6}px`
    ref.current.style.top = `${rect.top - 7}px`
  })
  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] leading-[15px] font-semibold whitespace-nowrap text-white/90 shadow-lg ring-1 ring-white/15"
    >
      {label}
      {number !== null && <span className="font-normal text-white/45">⌘{number}</span>}
    </span>
  )
}

function RowMetaLine({ meta }: { meta: RowMeta }) {
  return (
    <span className="flex h-[15px] min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-white/50">
      {meta.setup && (
        <span
          className={cn(
            'shrink-0 rounded px-[5px] text-[10px] leading-[14px] ring-1 ring-white/16 ring-inset',
            meta.setup.error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {meta.setup.text}
        </span>
      )}
      {meta.tallies.map((tally) => (
        <AgentTallyMark key={tally.kind} tally={tally} />
      ))}
      <AgentDotMark dot={meta.dot} />
      <span className={cn('min-w-0 flex-1 truncate', meta.infoMono && 'font-mono text-[10.5px]')}>
        {meta.info}
      </span>
      {meta.chip && (
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-[2px]"
          style={{ background: hueOf(meta.chip).fg }}
        />
      )}
      {meta.where && (
        <span
          className={cn(
            'max-w-[60%] min-w-0 truncate text-white/45',
            meta.whereMono && 'font-mono text-[10.5px]',
          )}
        >
          {meta.where}
        </span>
      )}
    </span>
  )
}

function RunspaceItem({
  row,
  listedIn,
  dragHandlers,
  isDragOver,
  hint,
}: {
  row: RunspaceRow
  listedIn: ListedIn
  dragHandlers: ReturnType<ReturnType<typeof useDragReorder>['handlersFor']>
  isDragOver: boolean
  hint?: string
}) {
  const draggedTabId = useAtomValue(draggedTabIdAtom)
  const moveTab = useSetAtom(moveTabToRunspaceAtom)
  const [tabOver, setTabOver] = useState(false)
  const meta = rowMetaOf(row, listedIn)

  return (
    <button
      {...dragHandlers}
      onPointerEnter={() => {
        dragHandlers.onPointerEnter()
        setTabOver(true)
      }}
      onPointerLeave={() => {
        dragHandlers.onPointerLeave()
        setTabOver(false)
      }}
      onPointerUp={() => {
        if (draggedTabId) void moveTab(draggedTabId, row.id)
      }}
      data-runspace-id={row.id}
      aria-label={rowLabel(row.title, meta, row.unreadCount)}
      className={cn(
        'flex w-full cursor-pointer flex-col items-stretch gap-[5px] rounded-lg px-2 py-[7px] text-left',
        'transition-colors duration-100',
        'focus-visible:ring-1 focus-visible:ring-white/30 focus-visible:outline-none',
        row.isActive
          ? 'bg-white/[0.1] text-foreground focus-visible:ring-white/50'
          : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
        (isDragOver || (tabOver && draggedTabId)) && 'ring-1 ring-sky-400/60',
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        {hint && <JumpHint hint={hint} ctrl />}
        <span
          className={cn(
            'min-w-0 flex-1 text-xs leading-[17px] font-medium text-pretty wrap-anywhere',
            row.titleIsPath && 'font-mono text-[11px] font-normal',
            row.unreadCount > 0 && UNREAD_LABEL_STYLE,
          )}
        >
          {row.title}
        </span>
        <UnreadCount count={row.unreadCount} className="mt-px" />
      </span>
      {meta && <RowMetaLine meta={meta} />}
    </button>
  )
}

function SectionHeader({ tileKey, section }: { tileKey: string; section: SidebarSection }) {
  const toggle = useSetAtom(toggleSectionAtom)
  const label = SECTION_LABELS[section.kind]
  return (
    <button
      type="button"
      aria-expanded={!section.collapsed}
      aria-label={section.collapsed ? withUnread(label, section.unreadCount) : label}
      {...pressHandlers(() => toggle(sectionKey(tileKey, section.kind)))}
      className="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-white/55 transition-colors hover:bg-white/[0.04] hover:text-white/85"
    >
      <span className="flex-1 text-left">{label}</span>
      {section.collapsed && (
        <span className="text-[10px] font-normal text-white/50">{section.rowCount}</span>
      )}
      {section.collapsed && <UnreadCount count={section.unreadCount} />}
      <ChevronRightIcon
        size={9}
        strokeWidth={3}
        className={cn(
          'shrink-0 transition-transform duration-150 motion-reduce:transition-none',
          !section.collapsed && 'rotate-90',
        )}
      />
    </button>
  )
}

export function TileHeading() {
  const { repo } = useAtomValue(sidebarAtom).selected
  if (!repo) return null
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="max-w-[75%] shrink-0 truncate text-sm font-semibold text-white/90">
        {repoName(repo)}
      </span>
      <span className="truncate text-[10px] text-white/50">{repo.slice(0, repo.indexOf('/'))}</span>
    </div>
  )
}

export function WorkbenchSidebar() {
  const sidebar = useAtomValue(sidebarAtom)
  const { pinned, tiles, selected } = sidebar
  const activate = useSetAtom(activateRunspaceAtom)
  const pickTile = useSetAtom(pickTileAtom)
  const reorder = useSetAtom(reorderRunspacesAtom)
  const jumpHints = useAtomValue(jumpHintTargetsAtom)
  const { dragOverId, handlersFor } = useDragReorder(reorder)
  const listedIn: ListedIn = selected.repo ? 'repo' : 'outside'

  const renderRunspace = (row: RunspaceRow, at: ListedIn) => (
    <RunspaceItem
      key={row.id}
      row={row}
      listedIn={at}
      dragHandlers={handlersFor(row.id, () => activate(row.id))}
      isDragOver={dragOverId === row.id}
      hint={jumpHints.byRunspaceId[row.id]}
    />
  )
  const tileButton = (tile: Tile) => (
    <TileButton
      key={tile.key}
      tile={tile}
      number={tileNumberOf(sidebar, tile.key)}
      selected={tile.key === selected.key}
      onPick={() => pickTile(tile.key)}
    />
  )

  return (
    <div className="flex min-h-0 flex-1">
      <div
        role="tablist"
        aria-label="Repos"
        aria-orientation="vertical"
        className="scrollbar-hide flex w-[46px] shrink-0 flex-col items-center gap-3 overflow-y-auto rounded-tr-[10px] bg-black/[0.14] pt-2 pb-4"
      >
        {tiles.filter((tile) => tile.repo).map(tileButton)}
        <span aria-hidden className="h-px w-[18px] shrink-0 bg-white/12" />
        {tiles.filter((tile) => !tile.repo).map(tileButton)}
      </div>
      <nav aria-label="Runspaces" className="min-w-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {pinned.length > 0 && (
          <div className="mb-0.5 flex flex-col gap-0.5 border-b border-white/[0.07] pt-1 pb-2">
            <div className="flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-semibold text-white/55">
              <PinIcon size={10} strokeWidth={2.6} className="text-rose-400" />
              Pinned
            </div>
            {pinned.map((row) => renderRunspace(row, 'pinned'))}
          </div>
        )}
        {selected.sections.map((section) => (
          <div key={section.kind} className="mt-2 flex flex-col gap-0.5">
            {section.headed && <SectionHeader tileKey={selected.key} section={section} />}
            {section.rows.map((row) => renderRunspace(row, listedIn))}
          </div>
        ))}
      </nav>
    </div>
  )
}
