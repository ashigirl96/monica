import { type Store, load } from "@tauri-apps/plugin-store";
import { atom, getDefaultStore } from "jotai";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SpaceId,
  activeSpaceAtom,
  sidebarOpenAtom,
  sidebarWidthAtom,
} from "@/stores/space";
import { clamp } from "@/lib/clamp";
import { clampUiZoom, uiZoomAtom } from "@/stores/zoom";

export const UI_STATE_FILE = "ui-state.json";

export type WorkbenchHint = { activeRunspaceId: string | null; activeTabId: string | null };
export type WorkboardHint = { focusedTaskId: string | null };

export type WindowUiState = {
  activeSpace: SpaceId;
  sidebarOpen: boolean;
  sidebarWidth: number;
  workbench: WorkbenchHint;
  workboard: WorkboardHint;
};

export type PersistedUiState = {
  global: { uiZoom: number };
  windows: Record<string, WindowUiState>;
};

export const MAIN_WINDOW_LABEL = "main";

export const windowLabelAtom = atom("");

const DEFAULT_WINDOW_STATE: WindowUiState = {
  activeSpace: "library",
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  workbench: { activeRunspaceId: null, activeTabId: null },
  workboard: { focusedTaskId: null },
};

const SPACE_IDS: Record<SpaceId, true> = {
  library: true,
  "work-board": true,
  "work-bench": true,
};

function isSpaceId(v: unknown): v is SpaceId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SPACE_IDS, v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function clampWidth(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return SIDEBAR_DEFAULT_WIDTH;
  return clamp(v, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

function parseWindowUiState(raw: unknown): WindowUiState {
  const r = asObject(raw);
  const wb = asObject(r.workbench);
  const wboard = asObject(r.workboard);
  return {
    activeSpace: isSpaceId(r.activeSpace) ? r.activeSpace : DEFAULT_WINDOW_STATE.activeSpace,
    sidebarOpen:
      typeof r.sidebarOpen === "boolean" ? r.sidebarOpen : DEFAULT_WINDOW_STATE.sidebarOpen,
    sidebarWidth: clampWidth(r.sidebarWidth),
    workbench: {
      activeRunspaceId: asString(wb.activeRunspaceId),
      activeTabId: asString(wb.activeTabId),
    },
    workboard: {
      focusedTaskId: asString(wboard.focusedTaskId),
    },
  };
}

export function parsePersistedUiState(raw: unknown): PersistedUiState {
  const r = asObject(raw);
  const global = asObject(r.global);
  const windowsRaw = asObject(r.windows);
  const windows: Record<string, WindowUiState> = {};
  for (const [label, value] of Object.entries(windowsRaw)) {
    windows[label] = parseWindowUiState(value);
  }
  return {
    global: { uiZoom: clampUiZoom(global.uiZoom) },
    windows,
  };
}

export function selectWindowUiState(state: PersistedUiState, windowLabel: string): WindowUiState {
  return state.windows[windowLabel] ?? state.windows[MAIN_WINDOW_LABEL] ?? DEFAULT_WINDOW_STATE;
}

export function serializeUiStatePatch(
  current: PersistedUiState,
  windowLabel: string,
  patch: WindowUiState,
  globalOverride?: PersistedUiState["global"],
): PersistedUiState {
  return {
    global: globalOverride ?? current.global,
    windows: { ...current.windows, [windowLabel]: patch },
  };
}

export async function writePersistedUiState(file: Store, state: PersistedUiState): Promise<void> {
  // Replace the two keys in place rather than clear()+set(): a bare clear() momentarily empties
  // the store the plugin shares across windows, so a concurrent reader in another window would
  // observe an empty `windows` map and drop every other window's state.
  await Promise.all([file.set("global", state.global), file.set("windows", state.windows)]);
  await file.save();
}

async function loadUiState(): Promise<{ file: Store; state: PersistedUiState }> {
  const file = await load(UI_STATE_FILE);
  const raw = Object.fromEntries(await file.entries());
  return { file, state: parsePersistedUiState(raw) };
}

export async function getSecondaryWindowLabels(): Promise<string[]> {
  try {
    const { state } = await loadUiState();
    return Object.keys(state.windows).filter((label) => label !== MAIN_WINDOW_LABEL);
  } catch {
    return [];
  }
}

export async function removeWindowEntry(windowLabel: string): Promise<void> {
  try {
    const { file, state } = await loadUiState();
    delete state.windows[windowLabel];
    await writePersistedUiState(file, state);
  } catch {
    // best-effort
  }
}

export async function ensureWindowEntry(windowLabel: string): Promise<void> {
  try {
    const { file, state } = await loadUiState();
    if (!state.windows[windowLabel]) {
      state.windows[windowLabel] = selectWindowUiState(state, windowLabel);
      await writePersistedUiState(file, state);
    }
  } catch {
    // best-effort
  }
}

export function resolveWorkbenchActive(
  runspaces: ReadonlyArray<{ id: string; tabs: ReadonlyArray<{ id: string }> }>,
  hint: WorkbenchHint,
): { activeRunspaceId: string; activeTabId: string } {
  const rs =
    (hint.activeRunspaceId ? runspaces.find((r) => r.id === hint.activeRunspaceId) : undefined) ??
    runspaces[0];
  if (!rs) return { activeRunspaceId: "", activeTabId: "" };
  const tab =
    (hint.activeTabId ? rs.tabs.find((t) => t.id === hint.activeTabId) : undefined) ?? rs.tabs[0];
  return { activeRunspaceId: rs.id, activeTabId: tab?.id ?? "" };
}

export function resolveWorkboardFocus(
  validTaskIds: ReadonlyArray<string>,
  hint: WorkboardHint,
): WorkboardHint {
  return {
    focusedTaskId:
      hint.focusedTaskId && validTaskIds.includes(hint.focusedTaskId) ? hint.focusedTaskId : null,
  };
}

export const pendingWorkbenchHintAtom = atom<WorkbenchHint | null>(null);
export const pendingWorkboardHintAtom = atom<WorkboardHint | null>(null);

type UiStateHydrationOptions = { windowLabel: string };

export async function hydrateUiState(options: UiStateHydrationOptions): Promise<void> {
  const store = getDefaultStore();
  let file: Store | null = null;
  let raw: Record<string, unknown> = {};
  try {
    file = await load(UI_STATE_FILE);
    raw = Object.fromEntries(await file.entries());
  } catch {
    file = null;
    raw = {};
  }
  const state = parsePersistedUiState(raw);
  // A file without `windows` predates the window-scoped shape (or is empty/corrupt): its top-level
  // keys can't be read into the new shape. Evict them once here — this runs at the first launch
  // after the shape change, before any window entry exists, so clear() can't drop another window's
  // state the way it would on the hot save path.
  if (file && !("windows" in raw)) {
    try {
      await file.clear();
      await writePersistedUiState(file, state);
    } catch {
      // initUiStatePersistence rewrites on the next change.
    }
  }
  const win = selectWindowUiState(state, options.windowLabel);
  store.set(uiZoomAtom, state.global.uiZoom);
  store.set(activeSpaceAtom, win.activeSpace);
  store.set(sidebarOpenAtom, win.sidebarOpen);
  store.set(sidebarWidthAtom, win.sidebarWidth);
  store.set(pendingWorkbenchHintAtom, win.workbench);
  store.set(pendingWorkboardHintAtom, win.workboard);
}
