import { useAtomValue } from "jotai";
import {
  activeSpaceAtom,
  sidebarOpenAtom,
  sidebarWidthAtom,
  sidebarResizingAtom,
  SPACE_NAV_WIDTH,
} from "@/stores/space";
import { getSpaceConfig } from "@/spaces/registry";
import { SpaceNav } from "@/components/space-nav";
import { ResizeHandle } from "@/components/resize-handle";
import { TabBar } from "@/components/tab-bar";
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
  const Content = space.content;

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
            minWidth: Sidebar
              ? SPACE_NAV_WIDTH + sidebarWidth
              : SPACE_NAV_WIDTH,
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
          className="flex h-10 flex-shrink-0 items-center transition-[padding] duration-200 ease-out"
          style={{
            paddingLeft: Math.max(16, TRAFFIC_LIGHT_ZONE_WIDTH - leftPanelWidth),
            paddingRight: 16,
          }}
          data-tauri-drag-region
        >
          <TabBar />
        </div>

        <div className="min-h-0 flex-1 p-2 pt-0">
          <div className="content-panel h-full select-text overflow-auto rounded-xl">
            <Content />
          </div>
        </div>
      </div>
    </div>
  );
}
