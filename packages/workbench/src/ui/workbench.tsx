import { cn, PromptIcon, TRAFFIC_LIGHT_ZONE_HEIGHT, TRAFFIC_LIGHT_ZONE_WIDTH } from '@monica/ui'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { lazy, Suspense, useEffect } from 'react'

import { WorkbenchHeader } from './header.tsx'
import { followMetaHold } from './meta-hold.ts'
import { followNotificationClicks } from './notification-click.ts'
import { ResizeHandle } from './resize-handle.tsx'
import type { BenchLabelOf } from './sidebar-model.ts'
import { TileHeading, WorkbenchSidebar } from './sidebar.tsx'
import {
  appendRunspacesJoiningTile,
  benchLabelOfAtom,
  lastTabClosedAtom,
  reloadAgentSessionsAtom,
  reloadAtom,
  warnFailed,
  type WorkbenchClient,
  workbenchClientAtom,
} from './store.ts'
import { TabContextMenu, type TabMenuItems } from './tab-context-menu.tsx'
import { persistUiState } from './ui-state-persistence.ts'
import { sidebarOpenAtom, sidebarResizingAtom, sidebarWidthAtom, uiZoomAtom } from './ui-state.ts'
import { followWindowFocus, markSeenWhileShown } from './unread.ts'

const WorkbenchContent = lazy(() => import('./content.tsx'))

// Backend が立ち直ると endpoint ごと替わり、前の購読は届かなくなるので、client ごとに張り直す。
function useWorkbenchChanges(client: WorkbenchClient | null) {
  const setClient = useSetAtom(workbenchClientAtom)
  const reload = useSetAtom(reloadAtom)
  const reloadAgentSessions = useSetAtom(reloadAgentSessionsAtom)

  useEffect(() => {
    setClient(() => client)
    if (!client) return
    const controller = new AbortController()
    const reloadLogged = () => reload().catch((e: unknown) => warnFailed('layout reload', e))
    const reloadAgentSessionsLogged = () =>
      reloadAgentSessions().catch((e: unknown) => warnFailed('agent session reload', e))
    void (async () => {
      try {
        // 先に購読してから読むので、読んだ後の変更を取りこぼさない。
        const changes = await client.changes(undefined, { signal: controller.signal })
        void reloadLogged()
        void reloadAgentSessionsLogged()
        // reconcile は Agent Session の合図を出さずに未観測や終了にするので、どの合図でも読み直す。
        for await (const change of changes) {
          if (change.type !== 'agentSession') void reloadLogged()
          void reloadAgentSessionsLogged()
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('workbench.changes ended', error)
      }
    })()
    return () => controller.abort()
  }, [client, setClient, reload, reloadAgentSessions])
}

// workbench は task を import しないので、Task に関わる表示と出来事は slot で受け渡す（ADR-0005）。
export function Workbench({
  client,
  benchLabelOf,
  tabMenuItems,
  onLastTabClosed,
}: {
  client: WorkbenchClient | null
  benchLabelOf?: BenchLabelOf
  tabMenuItems?: TabMenuItems
  onLastTabClosed?: (runspaceId: string) => void
}) {
  useWorkbenchChanges(client)
  const store = useStore()
  useEffect(() => persistUiState(store), [store])
  useEffect(() => followWindowFocus(store), [store])
  useEffect(() => markSeenWhileShown(store), [store])
  useEffect(() => followNotificationClicks(store), [store])
  useEffect(() => appendRunspacesJoiningTile(store), [store])
  useEffect(() => followMetaHold(store), [store])
  const setLastTabClosed = useSetAtom(lastTabClosedAtom)
  useEffect(
    () => setLastTabClosed(() => onLastTabClosed ?? null),
    [onLastTabClosed, setLastTabClosed],
  )
  const setBenchLabelOf = useSetAtom(benchLabelOfAtom)
  useEffect(() => setBenchLabelOf(() => benchLabelOf ?? null), [benchLabelOf, setBenchLabelOf])

  const sidebarOpen = useAtomValue(sidebarOpenAtom)
  const sidebarWidth = useAtomValue(sidebarWidthAtom)
  const resizing = useAtomValue(sidebarResizingAtom)
  const uiZoom = useAtomValue(uiZoomAtom)
  const leftPanelWidth = sidebarOpen ? sidebarWidth : 0

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden select-none">
      <div
        className={cn(
          'flex-shrink-0 overflow-hidden',
          !resizing && 'transition-[width] duration-200 ease-out',
        )}
        style={{ width: leftPanelWidth }}
      >
        <div className="flex h-full flex-col" style={{ minWidth: sidebarWidth }}>
          <div
            className="flex flex-shrink-0 items-center gap-2.5 pr-2"
            style={{
              height: TRAFFIC_LIGHT_ZONE_HEIGHT,
              paddingLeft: TRAFFIC_LIGHT_ZONE_WIDTH - 8,
            }}
            data-tauri-drag-region
          >
            <div className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/[0.08] px-2 py-0.5">
              <PromptIcon size={12} strokeWidth={2} />
              <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Workbench
              </span>
            </div>
            <TileHeading />
          </div>
          <WorkbenchSidebar />
        </div>
      </div>

      {sidebarOpen && <ResizeHandle />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-10 flex-shrink-0 items-center transition-[padding] duration-200 ease-out"
          style={{
            paddingLeft: Math.max(8, TRAFFIC_LIGHT_ZONE_WIDTH - leftPanelWidth),
            paddingRight: 8,
          }}
          data-tauri-drag-region
        >
          <WorkbenchHeader />
          <TabContextMenu tabMenuItems={tabMenuItems} />
        </div>
        <div className="relative min-h-0 flex-1 p-2 pt-0" style={{ zoom: uiZoom }}>
          <div className="content-panel h-full overflow-hidden">
            <Suspense>
              <WorkbenchContent />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
