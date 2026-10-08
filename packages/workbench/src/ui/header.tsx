import { cn, PinIcon, PlusIcon, useDragReorder } from '@monica/ui'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'

import { baseName } from '../paths.ts'
import { AgentDotMark } from './agent-dot-mark.tsx'
import { UNREAD_LABEL_STYLE } from './agent-dot.ts'
import { JumpHint } from './jump-hint.tsx'
import { jumpHintTargetsAtom, pendingCloseTabIdAtom } from './jump-hints.ts'
import {
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  agentDotOfTerminalSessionAtom,
  createTerminalTabAtom,
  deadTabsAtom,
  draggedTabIdAtom,
  reorderTabsAtom,
  tabMenuAtom,
  tabTitlesAtom,
  unreadOfTerminalSessionAtom,
} from './store.ts'

const TERMINAL_SESSION_STATUS_DOT: Record<string, string> = {
  exited: 'bg-zinc-500',
  lost: 'bg-amber-400',
  failed: 'bg-red-400',
}

export function WorkbenchHeader() {
  const runspace = useAtomValue(activeRunspaceAtom)
  const activeTab = useAtomValue(activeTerminalTabAtom)
  const titles = useAtomValue(tabTitlesAtom)
  const deadTabs = useAtomValue(deadTabsAtom)
  const agentDotOfTerminalSession = useAtomValue(agentDotOfTerminalSessionAtom)
  const unreadOfTerminalSession = useAtomValue(unreadOfTerminalSessionAtom)
  const setTabMenu = useSetAtom(tabMenuAtom)
  const activateTab = useSetAtom(activateTerminalTabAtom)
  const createTab = useSetAtom(createTerminalTabAtom)
  const reorder = useSetAtom(reorderTabsAtom)
  const setDraggedTab = useSetAtom(draggedTabIdAtom)
  const jumpHints = useAtomValue(jumpHintTargetsAtom)
  const pendingCloseTabId = useAtomValue(pendingCloseTabIdAtom)
  const { dragOverId, handlersFor } = useDragReorder(reorder, setDraggedTab)
  const activeTabRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 手前の Tab の button は ref でしか取れないので、手前の Tab が替わったときと並びが動いたときに走らせ直す。
  }, [activeTab?.id, activeTab?.sortOrder])

  if (!runspace) return null

  return (
    <div className="scrollbar-hide flex h-full items-center gap-1 overflow-x-auto">
      {runspace.tabs.map((tab) => {
        const isActive = tab.id === activeTab?.id
        const label = titles[tab.id] || baseName(tab.cwd)
        const status = deadTabs[tab.id]?.status
        const terminalDot = status ? TERMINAL_SESSION_STATUS_DOT[status] : undefined
        const hint = jumpHints.byTabId[tab.id]
        const unread = unreadOfTerminalSession(tab.terminalSessionId)
        return (
          <button
            key={tab.id}
            ref={isActive ? activeTabRef : undefined}
            data-tab-id={tab.id}
            {...handlersFor(tab.id, () => activateTab(tab.id))}
            onContextMenu={(e) => {
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setTabMenu({
                tabId: tab.id,
                anchor: { top: rect.top, bottom: rect.bottom, left: e.clientX },
              })
            }}
            className={cn(
              'group flex h-7 w-[220px] max-w-[220px] min-w-[220px] cursor-pointer items-center rounded-lg px-3 text-xs',
              'transition-colors duration-100',
              'focus-visible:ring-1 focus-visible:ring-white/30 focus-visible:outline-none',
              isActive
                ? 'bg-[var(--content-bg)] text-foreground shadow-sm focus-visible:ring-white/50'
                : 'bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground',
              dragOverId === tab.id && 'ring-1 ring-sky-400/60',
            )}
          >
            {hint && <JumpHint hint={hint} className="mr-1.5" />}
            {tab.pinned && <PinIcon size={14} className="mr-1.5 shrink-0 text-rose-400" />}
            <AgentDotMark
              dot={agentDotOfTerminalSession(tab.terminalSessionId)}
              unread={unread}
              className="mr-1.5"
            />
            {tab.id === pendingCloseTabId ? (
              <span className="flex-1 truncate font-semibold text-destructive">
                d again to close tab
              </span>
            ) : (
              <span className={cn('flex-1 truncate', unread && UNREAD_LABEL_STYLE)}>{label}</span>
            )}
            {terminalDot && (
              <span
                title={status}
                className={cn('ml-1.5 size-1.5 shrink-0 rounded-full', terminalDot)}
              />
            )}
          </button>
        )
      })}
      <button
        onClick={() => void createTab()}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        title="New tab (Ctrl+T, C)"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  )
}
