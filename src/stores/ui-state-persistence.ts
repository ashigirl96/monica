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

// App-lifetime owner for ui-state persistence. It observes atoms that live in feature slices
// (work-bench, work-board) because persistence must follow the canonical atom rather than a
// duplicate in stores/; module init (not a React effect) keeps the subscription single.
export function initUiStatePersistence(): void {
  const store = getDefaultStore();
  let file: Store | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = async () => {
    file ??= await load(UI_STATE_FILE);
    // focusedTaskId is cleared to null on Work Board unmount (the value moves to
    // focusMemory), so fall back to memory to capture the last focus on quit.
    const focusedTaskId = store.get(focusedTaskIdAtom) ?? store.get(focusMemoryAtom);
    const writes = [
      file.set("activeSpace", store.get(activeSpaceAtom)),
      file.set("sidebarOpen", store.get(sidebarOpenAtom)),
      file.set("sidebarWidth", store.get(sidebarWidthAtom)),
      file.set("uiZoom", store.get(uiZoomAtom)),
      file.set("workboard", { focusedTaskId }),
    ];
    // activeRunspaceAtom synthesizes a throwaway runspace with a random id until the
    // bench has loaded; persisting that would clobber the saved hint, so skip it.
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
