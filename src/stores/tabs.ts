import { atom } from "jotai";
import { activeSpaceAtom, type SpaceId } from "./space";

export type Tab = {
  id: string;
  label: string;
};

export type TabState = {
  tabs: Tab[];
  activeTabId: string | null;
  counter: number;
};

function createInitialTabState(): TabState {
  const id = crypto.randomUUID();
  return { tabs: [{ id, label: "Tab 1" }], activeTabId: id, counter: 1 };
}

export const tabsBySpaceAtom = atom<Record<SpaceId, TabState>>({
  dashboard: createInitialTabState(),
  project: createInitialTabState(),
  "work-board": createInitialTabState(),
  "work-bench": createInitialTabState(),
});

export const activeTabsAtom = atom((get) => {
  const space = get(activeSpaceAtom);
  return get(tabsBySpaceAtom)[space];
});

export const createTabAtom = atom(null, (get, set) => {
  const space = get(activeSpaceAtom);
  const all = get(tabsBySpaceAtom);
  const state = all[space];
  const counter = state.counter + 1;
  const id = crypto.randomUUID();
  const activeIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const insertIdx = activeIdx === -1 ? state.tabs.length : activeIdx + 1;
  const tabs = [...state.tabs];
  tabs.splice(insertIdx, 0, { id, label: `Tab ${counter}` });
  set(tabsBySpaceAtom, {
    ...all,
    [space]: { tabs, activeTabId: id, counter },
  });
});

export const closeTabAtom = atom(null, (get, set, tabId?: string) => {
  const space = get(activeSpaceAtom);
  const all = get(tabsBySpaceAtom);
  const state = all[space];
  if (state.tabs.length <= 1) return;

  const targetId = tabId ?? state.activeTabId;
  const idx = state.tabs.findIndex((t) => t.id === targetId);
  const newTabs = state.tabs.filter((t) => t.id !== targetId);
  const newActiveId =
    targetId === state.activeTabId
      ? newTabs[Math.min(idx, newTabs.length - 1)].id
      : state.activeTabId;

  set(tabsBySpaceAtom, {
    ...all,
    [space]: { ...state, tabs: newTabs, activeTabId: newActiveId },
  });
});

export const activateTabAtom = atom(null, (get, set, tabId: string) => {
  const space = get(activeSpaceAtom);
  const all = get(tabsBySpaceAtom);
  set(tabsBySpaceAtom, {
    ...all,
    [space]: { ...all[space], activeTabId: tabId },
  });
});

export const cycleTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  const space = get(activeSpaceAtom);
  const all = get(tabsBySpaceAtom);
  const state = all[space];
  if (state.tabs.length <= 1) return;

  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const newIdx =
    direction === "left"
      ? (idx - 1 + state.tabs.length) % state.tabs.length
      : (idx + 1) % state.tabs.length;

  set(tabsBySpaceAtom, {
    ...all,
    [space]: { ...state, activeTabId: state.tabs[newIdx].id },
  });
});
