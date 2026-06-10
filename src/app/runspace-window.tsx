import { Suspense, lazy, useEffect } from "react";
import { getDefaultStore } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WorkBenchHeader } from "@/spaces/work-bench/header";
import { markSessionDead } from "@/spaces/work-bench/use-terminal";
import { ptyKill } from "@/commands/pty";
import { terminalStateAtom } from "@/stores/terminal";
import { activeSpaceAtom, type SpaceId } from "@/stores/space";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { Toaster } from "@/components/toaster";
import { TRAFFIC_LIGHT_ZONE_WIDTH } from "@/lib/layout";

const LazyWorkBenchContent = lazy(() => import("@/spaces/work-bench/content"));

export function RunspaceWindow() {
  useHydrateAtoms([[activeSpaceAtom, "work-bench" as SpaceId]]);
  useShortcuts();

  useEffect(() => {
    // With a close-requested listener registered, Tauri defers the actual
    // destroy until the handler resolves, so the PTYs can be killed first.
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      const state = getDefaultStore().get(terminalStateAtom);
      if (!state) return;
      await Promise.allSettled(
        state.runspaces.flatMap((rs) =>
          rs.tabs.map((tab) => {
            markSessionDead(tab.id);
            return ptyKill(tab.id);
          }),
        ),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen select-none flex-col overflow-hidden">
      <div
        className="flex h-10 flex-shrink-0 items-center"
        style={{ paddingLeft: TRAFFIC_LIGHT_ZONE_WIDTH, paddingRight: 8 }}
        data-tauri-drag-region
      >
        <WorkBenchHeader />
      </div>
      <div className="min-h-0 flex-1 p-2 pt-0">
        <div className="content-panel h-full overflow-hidden">
          <Suspense>
            <LazyWorkBenchContent />
          </Suspense>
        </div>
      </div>
      <Toaster />
    </div>
  );
}
