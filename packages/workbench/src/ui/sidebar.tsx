import { cn, PinIcon, useDragReorder } from '@tania/ui'
import { useAtomValue, useSetAtom } from 'jotai'
import { type ReactNode, useState } from 'react'

import type { TerminalSession } from '../contract.ts'
import { shortPath } from '../paths.ts'
import { UNREAD_LABEL_STYLE } from './agent-dot.ts'
import { JumpHint } from './jump-hint.tsx'
import { jumpHintTargetsAtom } from './jump-hints.ts'
import {
  activateRunspaceAtom,
  draggedTabIdAtom,
  terminateTerminalSessionAtom,
  moveTabToRunspaceAtom,
  reattachTerminalSessionAtom,
  reorderRunspacesAtom,
  runspaceSummariesAtom,
  type RunspaceSummary,
  unreadOfTerminalSessionAtom,
} from './store.ts'
import { detachedTerminalSessionsAtom } from './terminal-sessions.ts'

function UnreadCount({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="mt-px inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-zinc-100 px-1 text-[9.5px] leading-none font-bold text-zinc-900">
      {count}
    </span>
  )
}

function DetachedTerminalSessionItem({
  terminalSession,
  unread,
  onReattach,
  onTerminate,
}: {
  terminalSession: TerminalSession
  unread: boolean
  onReattach: () => void
  onTerminate: () => void
}) {
  return (
    <div className="group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-muted-foreground">
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span
            className={cn(
              'block flex-1 truncate text-xs font-medium',
              unread && UNREAD_LABEL_STYLE,
            )}
          >
            {shortPath(terminalSession.cwd)}
          </span>
          <UnreadCount count={unread ? 1 : 0} />
        </div>
        <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
          {terminalSession.id}
        </span>
      </div>
      <button
        type="button"
        onClick={onReattach}
        className="rounded px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.1] hover:text-foreground"
      >
        Reattach
      </button>
      <button
        type="button"
        onClick={onTerminate}
        className="rounded px-1.5 py-0.5 text-[10px] text-destructive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/15"
      >
        Kill
      </button>
    </div>
  )
}

export type RenderRunspaceLabel = (runspaceId: string) => ReactNode

function RunspaceItem({
  runspace,
  dragHandlers,
  isDragOver,
  hint,
  renderLabel,
}: {
  runspace: RunspaceSummary
  dragHandlers: ReturnType<ReturnType<typeof useDragReorder>['handlersFor']>
  isDragOver: boolean
  hint?: string
  renderLabel?: RenderRunspaceLabel
}) {
  const draggedTabId = useAtomValue(draggedTabIdAtom)
  const moveTab = useSetAtom(moveTabToRunspaceAtom)
  const [tabOver, setTabOver] = useState(false)

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
        if (draggedTabId) void moveTab(draggedTabId, runspace.id)
      }}
      data-runspace-id={runspace.id}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left',
        'transition-colors duration-100',
        'focus-visible:ring-1 focus-visible:ring-white/30 focus-visible:outline-none',
        runspace.isActive
          ? 'bg-white/[0.1] text-foreground focus-visible:ring-white/50'
          : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
        (isDragOver || (tabOver && draggedTabId)) && 'ring-1 ring-sky-400/60',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1.5">
          {hint && <JumpHint hint={hint} ctrl />}
          {runspace.holdsPin && <PinIcon size={14} className="shrink-0 text-rose-400" />}
          <span
            className={cn(
              'flex-1 truncate text-xs leading-snug font-medium',
              runspace.unreadCount > 0 && UNREAD_LABEL_STYLE,
            )}
          >
            {(runspace.owned && renderLabel?.(runspace.id)) || runspace.title || 'Terminal'}
          </span>
          <UnreadCount count={runspace.unreadCount} />
        </div>
        {runspace.description && (
          <span className="truncate text-[10px] text-muted-foreground">{runspace.description}</span>
        )}
      </div>
    </button>
  )
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1">
      <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/50 uppercase">
        {label}
      </span>
    </div>
  )
}

function RunspaceGroup({
  label,
  items,
  renderItem,
}: {
  label: string
  items: RunspaceSummary[]
  renderItem: (runspace: RunspaceSummary) => React.ReactNode
}) {
  return (
    <>
      <GroupHeader label={label} />
      <div className="flex flex-col gap-0.5 px-0.5">{items.map(renderItem)}</div>
    </>
  )
}

export function WorkbenchSidebar({
  renderRunspaceLabel,
}: {
  renderRunspaceLabel?: RenderRunspaceLabel
}) {
  const summaries = useAtomValue(runspaceSummariesAtom)
  const detached = useAtomValue(detachedTerminalSessionsAtom)
  const activate = useSetAtom(activateRunspaceAtom)
  const reattach = useSetAtom(reattachTerminalSessionAtom)
  const terminate = useSetAtom(terminateTerminalSessionAtom)
  const reorder = useSetAtom(reorderRunspacesAtom)
  const jumpHints = useAtomValue(jumpHintTargetsAtom)
  const unreadOfTerminalSession = useAtomValue(unreadOfTerminalSessionAtom)
  const { dragOverId, handlersFor } = useDragReorder(reorder)

  const renderItem = (runspace: RunspaceSummary) => (
    <RunspaceItem
      key={runspace.id}
      runspace={runspace}
      dragHandlers={handlersFor(runspace.id, () => activate(runspace.id))}
      isDragOver={dragOverId === runspace.id}
      hint={jumpHints.byRunspaceId[runspace.id]}
      renderLabel={renderRunspaceLabel}
    />
  )

  const holdingPin = summaries.filter((s) => s.holdsPin)
  const rest = summaries.filter((s) => !s.holdsPin)

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {holdingPin.length > 0 && (
          <RunspaceGroup label="Pinned" items={holdingPin} renderItem={renderItem} />
        )}
        <RunspaceGroup
          label={holdingPin.length > 0 ? 'Runspaces' : ''}
          items={rest}
          renderItem={renderItem}
        />

        {detached.length > 0 && (
          <>
            <GroupHeader label="Detached" />
            <div className="flex flex-col gap-0.5 px-0.5">
              {detached.map((terminalSession) => (
                <DetachedTerminalSessionItem
                  key={terminalSession.id}
                  terminalSession={terminalSession}
                  unread={unreadOfTerminalSession(terminalSession.id)}
                  onReattach={() => void reattach(terminalSession.id)}
                  onTerminate={() => void terminate(terminalSession.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
