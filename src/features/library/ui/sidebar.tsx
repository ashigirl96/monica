import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { cn } from "@/lib/utils";
import {
  closeNotebookAtom,
  focusedNotebookIdAtom,
  notebooksAtom,
  pagesAtom,
  refreshNotebooksAtom,
  selectedNotebookIdAtom,
  selectedPageIdAtom,
  selectNotebookAtom,
} from "@/features/library/store";

const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

// "2026-06-25T10:00:00Z" -> "2026-06-25 10:00"; anything non-ISO passes through unchanged.
function formatCreated(iso: string): string {
  const m = iso.match(ISO_DATETIME_RE);
  return m ? `${m[1]} ${m[2]}` : iso;
}

export function LibrarySidebar() {
  const refresh = useSetAtom(refreshNotebooksAtom);
  useLiveRefresh(refresh);
  const selectedNotebookId = useAtomValue(selectedNotebookIdAtom);
  return selectedNotebookId === null ? <NotebookList /> : <PageList />;
}

function NotebookList() {
  const notebooks = useAtomValue(notebooksAtom);
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const [focusedId, setFocusedId] = useAtom(focusedNotebookIdAtom);

  // Keep the keyboard highlight on a real notebook so Enter always has a target.
  useEffect(() => {
    if (
      notebooks.length > 0 &&
      (focusedId === null || !notebooks.some((n) => n.id === focusedId))
    ) {
      setFocusedId(notebooks[0].id);
    }
  }, [notebooks, focusedId, setFocusedId]);

  if (notebooks.length === 0) {
    return <p className="px-2.5 py-2 text-xs text-muted-foreground/60">No notebooks yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5 py-1">
      {notebooks.map((nb) => {
        const focused = nb.id === focusedId;
        return (
          <li key={nb.id}>
            <button
              type="button"
              onClick={() => selectNotebook(nb.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[15px] transition-colors",
                focused
                  ? "bg-amber-400/15 text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 font-medium break-words">{nb.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground/50">{nb.page_count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PageList() {
  const pages = useAtomValue(pagesAtom);
  const activePageId = useAtomValue(selectedPageIdAtom);
  const setPageId = useSetAtom(selectedPageIdAtom);
  const closeNotebook = useSetAtom(closeNotebookAtom);
  const highlightId = activePageId ?? pages[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-0.5 py-1">
      <button
        type="button"
        onClick={() => closeNotebook()}
        className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-foreground"
      >
        <span aria-hidden>‹</span> Notebooks
      </button>
      {pages.map((page) => {
        const active = page.id === highlightId;
        return (
          <button
            key={page.id}
            type="button"
            onClick={() => setPageId(page.id)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
              active ? "bg-amber-400/15" : "hover:bg-white/[0.06]",
            )}
          >
            <span className="flex items-baseline gap-2.5">
              <span
                className={cn(
                  "w-[30px] shrink-0 text-right font-mono text-[11px] font-bold tabular-nums",
                  active ? "text-foreground" : "text-amber-300/90",
                )}
              >
                {page.number}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-[15px] break-words",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {page.title || page.id}
              </span>
            </span>
            {page.created !== null && (
              <span
                className={cn(
                  "pl-10 text-[11px]",
                  active ? "text-foreground/70" : "text-muted-foreground/55",
                )}
              >
                {formatCreated(page.created)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
