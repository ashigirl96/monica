import { atom, getDefaultStore } from "jotai";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import { queryKeys } from "@/stores/query-keys";
import {
  createDraft as createDraftCmd,
  listDrafts,
  listEssays,
  listIntentsByProject,
  listTimelineItems,
  saveDraft as saveDraftCmd,
} from "@/commands/artifact";
import type {
  ArtifactDraft,
  ArtifactDraftKind,
  EssayListItem,
  IntentGroup,
  TimelineCursor,
  TimelineItem,
} from "@/commands/artifact";

export type LibraryView = "timeline" | "essay" | "intent";

export type LibraryTab =
  | { id: "home"; kind: "home" }
  | { id: string; kind: "draft"; draftId: string }
  | { id: string; kind: "artifact"; artifactId: string };

type LibraryTabState = {
  tabs: LibraryTab[];
  activeTabId: string;
};

const HOME_TAB: LibraryTab = { id: "home", kind: "home" };

export const libraryViewAtom = atom<LibraryView>("timeline");

export const libraryTabStateAtom = atom<LibraryTabState>({
  tabs: [HOME_TAB],
  activeTabId: "home",
});

export const activeLibraryTabAtom = atom((get) => {
  const state = get(libraryTabStateAtom);
  return state.tabs.find((t) => t.id === state.activeTabId) ?? HOME_TAB;
});

export const openDraftTabAtom = atom(null, (get, set, draftId: string) => {
  const state = get(libraryTabStateAtom);
  const existing = state.tabs.find((t) => t.kind === "draft" && t.draftId === draftId);
  if (existing) {
    set(libraryTabStateAtom, { ...state, activeTabId: existing.id });
    return;
  }
  const id = crypto.randomUUID();
  const tab: LibraryTab = { id, kind: "draft", draftId };
  set(libraryTabStateAtom, {
    tabs: [...state.tabs, tab],
    activeTabId: id,
  });
});

export const openArtifactTabAtom = atom(null, (get, set, artifactId: string) => {
  const state = get(libraryTabStateAtom);
  const existing = state.tabs.find((t) => t.kind === "artifact" && t.artifactId === artifactId);
  if (existing) {
    set(libraryTabStateAtom, { ...state, activeTabId: existing.id });
    return;
  }
  const id = crypto.randomUUID();
  const tab: LibraryTab = { id, kind: "artifact", artifactId };
  set(libraryTabStateAtom, {
    tabs: [...state.tabs, tab],
    activeTabId: id,
  });
});

export const closeLibraryTabAtom = atom(null, (get, set, tabId?: string) => {
  const state = get(libraryTabStateAtom);
  const targetId = tabId ?? state.activeTabId;
  if (targetId === "home") return;

  const newTabs = state.tabs.filter((t) => t.id !== targetId);
  const idx = state.tabs.findIndex((t) => t.id === targetId);
  const newActiveId =
    targetId === state.activeTabId
      ? (newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? "home")
      : state.activeTabId;

  set(libraryTabStateAtom, { tabs: newTabs, activeTabId: newActiveId });
});

export const activateLibraryTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(libraryTabStateAtom);
  set(libraryTabStateAtom, { ...state, activeTabId: tabId });
});

export const promoteDraftToArtifactTabAtom = atom(
  null,
  (get, set, draftId: string, artifactId: string) => {
    const state = get(libraryTabStateAtom);
    const tabs = state.tabs.map((t): LibraryTab => {
      if (t.kind === "draft" && t.draftId === draftId) {
        return { id: t.id, kind: "artifact", artifactId };
      }
      return t;
    });
    set(libraryTabStateAtom, { ...state, tabs });
  },
);

export const cycleLibraryTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  const state = get(libraryTabStateAtom);
  if (state.tabs.length <= 1) return;
  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const newIdx =
    direction === "left"
      ? (idx - 1 + state.tabs.length) % state.tabs.length
      : (idx + 1) % state.tabs.length;
  set(libraryTabStateAtom, { ...state, activeTabId: state.tabs[newIdx].id });
});

export const VIEWS: LibraryView[] = ["timeline", "essay", "intent"];

export const cycleLibraryViewAtom = atom(null, (get, set, direction: "up" | "down") => {
  const current = get(libraryViewAtom);
  const idx = VIEWS.indexOf(current);
  const newIdx =
    direction === "down" ? (idx + 1) % VIEWS.length : (idx - 1 + VIEWS.length) % VIEWS.length;
  set(libraryViewAtom, VIEWS[newIdx]);
  const state = get(libraryTabStateAtom);
  set(libraryTabStateAtom, { ...state, activeTabId: "home" });
});

export const essaysQueryAtom = atomWithQuery(() => ({
  queryKey: queryKeys.artifacts.essays(),
  queryFn: () => listEssays(),
}));

export const essaysAtom = atom<EssayListItem[]>((get) => get(essaysQueryAtom).data ?? []);

export const intentsQueryAtom = atomWithQuery(() => ({
  queryKey: queryKeys.artifacts.intents(),
  queryFn: () => listIntentsByProject(),
}));

export const intentsAtom = atom<IntentGroup[]>((get) => get(intentsQueryAtom).data ?? []);

export const draftsQueryAtom = atomWithQuery(() => ({
  queryKey: queryKeys.artifacts.drafts(),
  queryFn: () => listDrafts(),
}));

export const draftsAtom = atom<ArtifactDraft[]>((get) => get(draftsQueryAtom).data ?? []);

export const timelineItemsAtom = atom<TimelineItem[]>([]);
export const timelineCursorAtom = atom<TimelineCursor | null>(null);
export const timelineHasMoreAtom = atom(true);
export const timelineLoadingAtom = atom(false);

export const loadTimelineAtom = atom(null, async (get, set, reset?: boolean) => {
  if (get(timelineLoadingAtom)) return;
  set(timelineLoadingAtom, true);

  try {
    const cursor = reset ? null : get(timelineCursorAtom);
    const since = !cursor ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() : null;
    const items = await listTimelineItems(cursor, since, 30);

    if (reset) {
      set(timelineItemsAtom, items);
    } else {
      set(timelineItemsAtom, [...get(timelineItemsAtom), ...items]);
    }

    if (items.length > 0) {
      const last = items[items.length - 1];
      set(timelineCursorAtom, {
        timeline_at: last.timeline_at,
        item_key: last.item_key,
      });
    }
    set(timelineHasMoreAtom, items.length >= 30);
  } finally {
    set(timelineLoadingAtom, false);
  }
});

function invalidateArtifacts() {
  const client = getDefaultStore().get(queryClientAtom);
  client.invalidateQueries({ queryKey: queryKeys.artifacts.family() });
}

export const createNewDraftAtom = atom(null, async (get, set) => {
  const view = get(libraryViewAtom);
  const kind: ArtifactDraftKind =
    view === "essay"
      ? { type: "essay", title: null }
      : view === "intent"
        ? { type: "intent", title: null, project_id: null }
        : { type: "memo" };

  const draft = await createDraftCmd(kind);
  set(openDraftTabAtom, draft.id);
  invalidateArtifacts();
});

export const saveDraftAtom = atom(null, async (_get, set, draftId: string) => {
  const artifact = await saveDraftCmd(draftId);
  set(promoteDraftToArtifactTabAtom, draftId, artifact.id);
  invalidateArtifacts();
  return artifact;
});
