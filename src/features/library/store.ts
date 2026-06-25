import { atom } from "jotai";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import { getNotebookPages, listNotebooks, type NotebookPageRow } from "@/commands/notebook";
import { queryKeys } from "@/stores/query-keys";

export const selectedNotebookIdAtom = atom<string | null>(null);
// The page section currently "active" (highlighted in the sidebar). Set by scroll-spy as the reader
// scrolls, and by clicking a page / jumping with alt+j-k.
export const selectedPageIdAtom = atom<string | null>(null);

// Keyboard highlight in the notebooks list (no notebook open yet). alt+j/k moves it, Enter opens.
export const focusedNotebookIdAtom = atom<string | null>(null);

export const selectNotebookAtom = atom(null, (_get, set, notebookId: string) => {
  set(selectedNotebookIdAtom, notebookId);
  set(selectedPageIdAtom, null);
});

// Back to the notebooks list; the closed notebook stays highlighted.
export const closeNotebookAtom = atom(null, (get, set) => {
  const current = get(selectedNotebookIdAtom);
  if (current !== null) set(focusedNotebookIdAtom, current);
  set(selectedNotebookIdAtom, null);
  set(selectedPageIdAtom, null);
});

const notebooksQueryAtom = atomWithQuery(() => ({
  queryKey: queryKeys.notebooks.list(),
  queryFn: () => listNotebooks(),
}));
export const notebooksAtom = atom((get) => get(notebooksQueryAtom).data ?? []);

// Focusing a notebook in the list previews it; opening one pins it. The content pane follows this
// "active" notebook either way, so list-preview and detail share one render path.
export const effectiveNotebookIdAtom = atom(
  (get) => get(selectedNotebookIdAtom) ?? get(focusedNotebookIdAtom),
);

// One fetch per notebook returns every page (outline order) *with its body*, so the content pane
// can render the whole notebook as one connected document. Deliberately not polled — refetching
// bodies under the reader would re-mount shiki/mermaid and jump the scroll.
const pagesQueryAtom = atomWithQuery((get) => {
  const notebookId = get(effectiveNotebookIdAtom);
  return {
    queryKey: queryKeys.notebooks.pages(notebookId ?? ""),
    queryFn: () => getNotebookPages(notebookId as string),
    enabled: notebookId !== null,
  };
});
export const pagesAtom = atom<NotebookPageRow[]>((get) => get(pagesQueryAtom).data ?? []);

export type Breadcrumb = {
  notebookTitle: string;
  pageTitle: string | null;
};

export const breadcrumbAtom = atom<Breadcrumb | null>((get) => {
  const notebookId = get(selectedNotebookIdAtom);
  if (notebookId === null) return null;
  const notebook = get(notebooksAtom).find((n) => n.id === notebookId);
  const pages = get(pagesAtom);
  const active = get(selectedPageIdAtom);
  const page = pages.find((p) => p.id === active) ?? pages[0];
  return {
    notebookTitle: notebook?.title ?? notebookId,
    pageTitle: page?.title ?? null,
  };
});

// Clamped step through an ordered, id-keyed list (shared by page jump and notebook-list focus).
function stepId(
  items: ReadonlyArray<{ id: string }>,
  currentId: string | null,
  direction: "next" | "prev",
): string | null {
  if (items.length === 0) return null;
  const idx = items.findIndex((x) => x.id === currentId);
  if (idx === -1) return items[0].id;
  const nextIdx = direction === "next" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
  return items[nextIdx].id;
}

// The content pane's scroll container, registered by the content component so keyboard shortcuts can
// drive it.
export const contentScrollElAtom = atom<HTMLElement | null>(null);

// j/k scroll step, shared with the Workbench plan preview so the two readers feel the same.
export const SCROLL_STEP = 120;

// j / k: nudge the reading pane.
export const scrollContentByAtom = atom(null, (get, _set, direction: "down" | "up") => {
  const el = get(contentScrollElAtom);
  el?.scrollBy({ top: direction === "down" ? SCROLL_STEP : -SCROLL_STEP });
});

// alt+j / alt+k in an opened notebook: show the previous/next page (the detail view renders one
// page at a time). Falls back to the first page so the first keypress steps off it.
export const cyclePageAtom = atom(null, (get, set, direction: "next" | "prev") => {
  const pages = get(pagesAtom);
  const current = get(selectedPageIdAtom) ?? pages[0]?.id ?? null;
  const next = stepId(pages, current, direction);
  if (next !== null) set(selectedPageIdAtom, next);
});

// alt+j / alt+k in the notebooks list: move the highlight (Enter opens it).
export const cycleNotebookFocusAtom = atom(null, (get, set, direction: "next" | "prev") => {
  const next = stepId(get(notebooksAtom), get(focusedNotebookIdAtom), direction);
  if (next !== null) set(focusedNotebookIdAtom, next);
});

export const openFocusedNotebookAtom = atom(null, (get, set) => {
  const id = get(focusedNotebookIdAtom);
  if (id !== null) set(selectNotebookAtom, id);
});

// Poll target for `useLiveRefresh`: only the notebooks list (so newly created notebooks appear).
// The open document is intentionally left alone — see `pagesQueryAtom`.
export const refreshNotebooksAtom = atom(null, (get) => {
  const client = get(queryClientAtom);
  return client.invalidateQueries({ queryKey: queryKeys.notebooks.list() });
});
