import { type Store, load } from "@tauri-apps/plugin-store";
import { getDefaultStore } from "jotai";
import {
  activeRunspaceAtom,
  activeTerminalTabAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom, sidebarOpenAtom, sidebarWidthAtom } from "@/stores/space";
import { uiZoomAtom } from "@/stores/zoom";
import { UI_STATE_FILE } from "@/stores/ui-state";
import { focusMemoryAtom, focusedTaskIdAtom } from "@/features/work-board/nav";

const SAVE_DEBOUNCE_MS = 500;

export function initUiStatePersistence(): void {
  const store = getDefaultStore();
  let file: Store | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = async () => {
    file ??= await load(UI_STATE_FILE);
    const focusedTaskId = store.get(focusedTaskIdAtom) ?? store.get(focusMemoryAtom);
    const writes = [
      file.set("activeSpace", store.get(activeSpaceAtom)),
      file.set("sidebarOpen", store.get(sidebarOpenAtom)),
      file.set("sidebarWidth", store.get(sidebarWidthAtom)),
      file.set("uiZoom", store.get(uiZoomAtom)),
      file.set("workboard", { focusedTaskId }),
    ];
    if (store.get(terminalStateAtom) !== null) {
      const tab = store.get(activeTerminalTabAtom);
      writes.push(
        file.set("workbench", {
          activeRunspaceId: store.get(activeRunspaceAtom)?.id ?? null,
          activeTabId: tab?.id ?? null,
        }),
      );
    }
    await Promise.all(writes);
    await file.save();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      write().catch((e) => console.warn("ui-state save failed:", e));
    }, SAVE_DEBOUNCE_MS);
  };

  const sources = [
    activeSpaceAtom,
    sidebarOpenAtom,
    sidebarWidthAtom,
    uiZoomAtom,
    activeRunspaceAtom,
    activeTerminalTabAtom,
    focusedTaskIdAtom,
    focusMemoryAtom,
  ];
  for (const source of sources) store.sub(source, schedule);
}
