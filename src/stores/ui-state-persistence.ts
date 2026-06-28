import { type Store, load } from "@tauri-apps/plugin-store";
import { getDefaultStore } from "jotai";
import {
  activeRunspaceAtom,
  activeTerminalTabAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom, sidebarOpenAtom, sidebarWidthAtom } from "@/stores/space";
import { uiZoomAtom } from "@/stores/zoom";
import {
  MAIN_WINDOW_LABEL,
  UI_STATE_FILE,
  parsePersistedUiState,
  serializeUiStatePatch,
  writePersistedUiState,
} from "@/stores/ui-state";
import { focusMemoryAtom, focusedTaskIdAtom } from "@/features/work-board/nav";

const SAVE_DEBOUNCE_MS = 500;

type UiStatePersistenceOptions = { windowLabel: string };

export function initUiStatePersistence(options: UiStatePersistenceOptions): void {
  const store = getDefaultStore();
  let file: Store | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let pending = false;
  // uiZoom is a shared global preference with no live cross-window sync yet, so this window's atom
  // can be stale. Only push the local zoom to the persisted global when the user changed it *here*;
  // otherwise a save triggered by an unrelated change would clobber a zoom set by another window.
  let zoomChangedHere = false;

  const write = async () => {
    file ??= await load(UI_STATE_FILE);
    const current = parsePersistedUiState(Object.fromEntries(await file.entries()));
    const existingWindow =
      current.windows[options.windowLabel] ?? current.windows[MAIN_WINDOW_LABEL];
    // Keep the previously saved workbench hint until the WorkBench has loaded: terminalStateAtom
    // is null before then, and reading the derived runspace atoms would persist an empty hint.
    const workbench =
      store.get(terminalStateAtom) !== null
        ? {
            activeRunspaceId: store.get(activeRunspaceAtom)?.id ?? null,
            activeTabId: store.get(activeTerminalTabAtom)?.id ?? null,
          }
        : (existingWindow?.workbench ?? { activeRunspaceId: null, activeTabId: null });
    const focusedTaskId = store.get(focusedTaskIdAtom) ?? store.get(focusMemoryAtom);
    const globalOverride = zoomChangedHere ? { uiZoom: store.get(uiZoomAtom) } : undefined;
    zoomChangedHere = false;
    const next = serializeUiStatePatch(
      current,
      options.windowLabel,
      {
        activeSpace: store.get(activeSpaceAtom),
        sidebarOpen: store.get(sidebarOpenAtom),
        sidebarWidth: store.get(sidebarWidthAtom),
        workbench,
        workboard: { focusedTaskId },
      },
      globalOverride,
    );
    await writePersistedUiState(file, next);
  };

  // Serialize writes: each write does a read-modify-write, so overlapping runs could land out of
  // order and persist a stale snapshot. Coalesce changes that arrive mid-write into one trailing run.
  const flush = () => {
    if (writing) {
      pending = true;
      return;
    }
    writing = true;
    write()
      .catch((e) => console.warn("ui-state save failed:", e))
      .finally(() => {
        writing = false;
        if (pending) {
          pending = false;
          flush();
        }
      });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const sources = [
    activeSpaceAtom,
    sidebarOpenAtom,
    sidebarWidthAtom,
    activeRunspaceAtom,
    activeTerminalTabAtom,
    focusedTaskIdAtom,
    focusMemoryAtom,
  ];
  for (const source of sources) store.sub(source, schedule);
  store.sub(uiZoomAtom, () => {
    zoomChangedHere = true;
    schedule();
  });
}
