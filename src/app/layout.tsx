import { Suspense, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  activeSpaceAtom,
  sidebarOpenAtom,
  sidebarWidthAtom,
  sidebarResizingAtom,
} from "@/stores/space";
import { uiZoomAtom } from "@/stores/zoom";
import { getSpaceConfig, spaces } from "@/spaces/registry";
import { ResizeHandle } from "@/components/resize-handle";
import { Toaster } from "@/components/toaster";
import { SettingsModal } from "@/features/settings/ui/settings-modal";
import { TaskMemoModal } from "@/features/task-memo/ui/memo-modal";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { TRAFFIC_LIGHT_ZONE_HEIGHT, TRAFFIC_LIGHT_ZONE_WIDTH } from "@/lib/layout";
import { cn } from "@/lib/utils";

export function AppLayout() {
  useShortcuts();

  const sidebarOpen = useAtomValue(sidebarOpenAtom);
  const activeSpace = useAtomValue(activeSpaceAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const resizing = useAtomValue(sidebarResizingAtom);
  const uiZoom = useAtomValue(uiZoomAtom);
  const space = getSpaceConfig(activeSpace);

  const Icon = space.icon;
  const Sidebar = space.sidebar;
  const Header = space.header;
  const Content = space.content;

  const visitedRef = useRef(new Set<string>());
  visitedRef.current.add(activeSpace);

  const activePersistent = space.persistent;
  const persistentSpaces = spaces.filter((s) => s.persistent && visitedRef.current.has(s.id));

  const hasSidebar = sidebarOpen && !!Sidebar;
  const leftPanelWidth = hasSidebar ? sidebarWidth : 0;

  return (
    <div className="flex h-screen w-screen select-none overflow-hidden">
      <div
        className={cn(
          "flex-shrink-0 overflow-hidden",
          !resizing && "transition-[width] duration-200 ease-out",
        )}
        style={{ width: leftPanelWidth }}
      >
        {Sidebar && (
          <div className="flex h-full flex-col" style={{ minWidth: sidebarWidth }}>
            <div
              className="flex flex-shrink-0 items-center"
              style={{
                height: TRAFFIC_LIGHT_ZONE_HEIGHT,
                paddingLeft: TRAFFIC_LIGHT_ZONE_WIDTH - 8,
              }}
              data-tauri-drag-region
            >
              <div className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2 py-0.5">
                <Icon size={12} strokeWidth={2} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {space.label}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2">
              <Sidebar />
            </div>
          </div>
        )}
      </div>

      {hasSidebar && <ResizeHandle />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-10 flex-shrink-0 items-center transition-[padding] duration-200 ease-out"
          style={{
            paddingLeft: Math.max(8, TRAFFIC_LIGHT_ZONE_WIDTH - leftPanelWidth),
            paddingRight: 8,
          }}
          data-tauri-drag-region
        >
          <Header />
        </div>

        <div className="relative min-h-0 flex-1 p-2 pt-0" style={{ zoom: uiZoom }}>
          {!activePersistent && (
            <div className="content-panel h-full select-text overflow-auto rounded-xl">
              <Suspense>
                <Content />
              </Suspense>
            </div>
          )}

          {persistentSpaces.map((s) => {
            const isActive = s.id === activeSpace;
            return (
              <div
                key={s.id}
                className={isActive ? "h-full" : "absolute inset-x-2 bottom-2 top-0"}
                style={isActive ? undefined : { opacity: 0, pointerEvents: "none" }}
                {...(isActive ? {} : { inert: true })}
              >
                <div className="content-panel h-full overflow-hidden">
                  <Suspense>
                    <s.content />
                  </Suspense>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TaskMemoModal />
      <SettingsModal />
      <Toaster />
    </div>
  );
}
