import { load } from "@tauri-apps/plugin-store";
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
import { UI_ZOOM_DEFAULT, clampUiZoom, uiZoomAtom } from "@/stores/zoom";

export const UI_STATE_FILE = "ui-state.json";

export type WorkbenchHint = { activeRunspaceId: string | null; activeTabId: string | null };
export type WorkboardHint = { focusedTaskId: string | null };

export type PersistedUiState = {
  activeSpace: SpaceId;
  sidebarOpen: boolean;
  sidebarWidth: number;
  uiZoom: number;
  workbench: WorkbenchHint;
  workboard: WorkboardHint;
};

const DEFAULT_UI_STATE: PersistedUiState = {
  activeSpace: "dashboard",
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  uiZoom: UI_ZOOM_DEFAULT,
  workbench: { activeRunspaceId: null, activeTabId: null },
  workboard: { focusedTaskId: null },
};

// Missing a key here is a compile error when SpaceId gains a variant, so validation
// can never silently drift behind the type.
const SPACE_IDS: Record<SpaceId, true> = {
  dashboard: true,
  project: true,
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

export function parseUiState(raw: unknown): PersistedUiState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_UI_STATE;
  const r = raw as Record<string, unknown>;
  const wb = asObject(r.workbench);
  const wboard = asObject(r.workboard);
  return {
    activeSpace: isSpaceId(r.activeSpace) ? r.activeSpace : DEFAULT_UI_STATE.activeSpace,
    sidebarOpen: typeof r.sidebarOpen === "boolean" ? r.sidebarOpen : DEFAULT_UI_STATE.sidebarOpen,
    sidebarWidth: clampWidth(r.sidebarWidth),
    uiZoom: clampUiZoom(r.uiZoom),
    workbench: {
      activeRunspaceId: asString(wb.activeRunspaceId),
      activeTabId: asString(wb.activeTabId),
    },
    workboard: {
      focusedTaskId: asString(wboard.focusedTaskId),
    },
  };
}

// Active selection is a view intent owned by the Tauri store; SQLite only knows which
// runspaces/tabs exist. Prefer the saved hint, fall back to the first runspace/tab when
// it points at something that no longer exists (deleted, or another environment's id).
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

// One-shot: the consumer clears this after validating the hint against its freshly
// loaded topology, so stale ids from a deleted/foreign environment never apply.
export const pendingWorkbenchHintAtom = atom<WorkbenchHint | null>(null);
export const pendingWorkboardHintAtom = atom<WorkboardHint | null>(null);

export async function hydrateUiState(): Promise<void> {
  const store = getDefaultStore();
  let parsed = DEFAULT_UI_STATE;
  try {
    const file = await load(UI_STATE_FILE);
    const [activeSpace, sidebarOpen, sidebarWidth, uiZoom, workbench, workboard] =
      await Promise.all([
        file.get("activeSpace"),
        file.get("sidebarOpen"),
        file.get("sidebarWidth"),
        file.get("uiZoom"),
        file.get("workbench"),
        file.get("workboard"),
      ]);
    parsed = parseUiState({ activeSpace, sidebarOpen, sidebarWidth, uiZoom, workbench, workboard });
  } catch {
    parsed = DEFAULT_UI_STATE;
  }
  store.set(activeSpaceAtom, parsed.activeSpace);
  store.set(sidebarOpenAtom, parsed.sidebarOpen);
  store.set(sidebarWidthAtom, parsed.sidebarWidth);
  store.set(uiZoomAtom, parsed.uiZoom);
  store.set(pendingWorkbenchHintAtom, parsed.workbench);
  store.set(pendingWorkboardHintAtom, parsed.workboard);
}
