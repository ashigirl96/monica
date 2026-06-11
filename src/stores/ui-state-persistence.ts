import { type Store, load } from "@tauri-apps/plugin-store";
import { getDefaultStore } from "jotai";
import {
  activeRunspaceAtom,
  activeTerminalTabAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom, sidebarOpenAtom, sidebarWidthAtom } from "@/stores/space";
import { UI_STATE_FILE } from "@/stores/ui-state";
import { selectedProjectAtom } from "@/stores/workboard";
import { focusMemoryAtom, focusedTaskIdAtom } from "@/stores/workboard-nav";

const SAVE_DEBOUNCE_MS = 500;

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
      file.set("workboard", {
        selectedProject: store.get(selectedProjectAtom),
        focusedTaskId,
      }),
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
    activeRunspaceAtom,
    activeTerminalTabAtom,
    selectedProjectAtom,
    focusedTaskIdAtom,
    focusMemoryAtom,
  ];
  for (const source of sources) store.sub(source, schedule);
}
