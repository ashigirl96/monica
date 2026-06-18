import { Suspense, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  activeSpaceAtom,
  sidebarOpenAtom,
  sidebarWidthAtom,
  sidebarResizingAtom,
  SPACE_NAV_WIDTH,
} from "@/stores/space";
import { getSpaceConfig, spaces } from "@/spaces/registry";
import { SpaceNav } from "@/components/space-nav";
import { ResizeHandle } from "@/components/resize-handle";
import { Toaster } from "@/components/toaster";
import { CaptureModal, GlobalCaptureButton } from "@/features/text-memory/ui/capture-modal";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { TRAFFIC_LIGHT_ZONE_HEIGHT, TRAFFIC_LIGHT_ZONE_WIDTH } from "@/lib/layout";
import { cn } from "@/lib/utils";

export function AppLayout() {
  useShortcuts();

  const sidebarOpen = useAtomValue(sidebarOpenAtom);
  const activeSpace = useAtomValue(activeSpaceAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const resizing = useAtomValue(sidebarResizingAtom);
  const space = getSpaceConfig(activeSpace);

  const Sidebar = space.sidebar;
  const Header = space.header;
  const Content = space.content;

  const visitedRef = useRef(new Set<string>());
  visitedRef.current.add(activeSpace);

  const activePersistent = space.persistent;
  const persistentSpaces = spaces.filter((s) => s.persistent && visitedRef.current.has(s.id));

  const hasSidebar = sidebarOpen && !!Sidebar;
  const leftPanelWidth = !sidebarOpen
    ? 0
    : Sidebar
      ? SPACE_NAV_WIDTH + sidebarWidth
      : SPACE_NAV_WIDTH;

  return (
    <div className="flex h-screen w-screen select-none overflow-hidden">
      <div
        className={cn(
          "flex-shrink-0 overflow-hidden",
          !resizing && "transition-[width] duration-200 ease-out",
        )}
        style={{ width: leftPanelWidth }}
      >
        <div
          className="flex h-full"
          style={{
            minWidth: Sidebar ? SPACE_NAV_WIDTH + sidebarWidth : SPACE_NAV_WIDTH,
          }}
        >
          <SpaceNav />
          {Sidebar && (
            <div className="flex flex-col" style={{ width: sidebarWidth }}>
              <div
                className="flex-shrink-0"
                style={{ height: TRAFFIC_LIGHT_ZONE_HEIGHT }}
                data-tauri-drag-region
              />
              <div className="flex-1 overflow-y-auto px-2">
                <Sidebar />
              </div>
            </div>
          )}
        </div>
      </div>

      {hasSidebar && <ResizeHandle />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-10 flex-shrink-0 items-center gap-2 transition-[padding] duration-200 ease-out"
          style={{
            paddingLeft: Math.max(8, TRAFFIC_LIGHT_ZONE_WIDTH - leftPanelWidth),
            paddingRight: 8,
          }}
          data-tauri-drag-region
        >
          <div className="min-w-0 flex-1">
            <Header />
          </div>
          <GlobalCaptureButton />
        </div>

        <div className="relative min-h-0 flex-1 p-2 pt-0">
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

      <Toaster />
      <CaptureModal />
    </div>
  );
}
