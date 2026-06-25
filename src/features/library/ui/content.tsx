import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { libraryModeAtom } from "@/stores/library";
import {
  contentScrollElAtom,
  effectiveNotebookIdAtom,
  pagesAtom,
  selectedNotebookIdAtom,
  selectedPageIdAtom,
} from "@/features/library/store";

const NotebookMarkdown = lazy(() => import("./notebook-markdown"));

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-sm text-muted-foreground/30">{text}</span>
    </div>
  );
}

const PageFallback = <div className="py-2 text-xs text-muted-foreground/40">Loading…</div>;

function NotebooksView() {
  const notebookId = useAtomValue(effectiveNotebookIdAtom);
  const opened = useAtomValue(selectedNotebookIdAtom) !== null;
  const pages = useAtomValue(pagesAtom);
  const selectedPageId = useAtomValue(selectedPageIdAtom);
  const setScrollEl = useSetAtom(contentScrollElAtom);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const registerScroll = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      setScrollEl(el);
    },
    [setScrollEl],
  );

  const shownPage = pages.find((p) => p.id === selectedPageId) ?? pages[0];

  // Opened (detail) view shows one page at a time — return to the top when the shown page changes.
  useEffect(() => {
    if (opened) scrollRef.current?.scrollTo({ top: 0 });
  }, [opened, shownPage?.id]);

  if (notebookId === null) return <EmptyState text="Select a notebook" />;
  if (!shownPage) return <EmptyState text="This notebook has no pages" />;

  return (
    <div ref={registerScroll} className="h-full overflow-y-auto px-8 py-12 scrollbar-hide">
      {opened ? (
        // Detail: a single page.
        <Suspense fallback={PageFallback}>
          <NotebookMarkdown body={shownPage.body} />
        </Suspense>
      ) : (
        // List preview: the whole notebook stitched together, one page per section.
        <div className="notebook-md">
          {pages.map((page) => (
            <section key={page.id} className="notebook-page">
              <Suspense fallback={PageFallback}>
                <NotebookMarkdown body={page.body} />
              </Suspense>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryContent() {
  const mode = useAtomValue(libraryModeAtom);
  return mode === "notebooks" ? <NotebooksView /> : null;
}

export default LibraryContent;
