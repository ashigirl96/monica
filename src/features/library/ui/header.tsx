import { useAtomValue, useSetAtom } from "jotai";
import { breadcrumbAtom, closeNotebookAtom } from "@/features/library/store";

export function LibraryHeader() {
  const breadcrumb = useAtomValue(breadcrumbAtom);
  const closeNotebook = useSetAtom(closeNotebookAtom);

  if (breadcrumb === null) return null;

  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => closeNotebook()}
        className="shrink-0 truncate font-medium text-foreground transition-colors hover:text-muted-foreground"
      >
        {breadcrumb.notebookTitle}
      </button>
      {breadcrumb.pageTitle !== null && (
        <>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{breadcrumb.pageTitle}</span>
        </>
      )}
    </nav>
  );
}
