import { useAtomValue, useSetAtom } from "jotai";
import {
  libraryViewAtom,
  libraryTabStateAtom,
  draftsAtom,
  openDraftTabAtom,
  VIEWS,
  type LibraryView,
} from "@/features/library/store";
import { cn } from "@/lib/utils";

const VIEW_ENTRIES: { id: LibraryView; label: string }[] = VIEWS.map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
}));

export function LibrarySidebar() {
  const activeView = useAtomValue(libraryViewAtom);
  const setView = useSetAtom(libraryViewAtom);
  const setTabState = useSetAtom(libraryTabStateAtom);
  const drafts = useAtomValue(draftsAtom);
  const openDraft = useSetAtom(openDraftTabAtom);

  function selectView(view: LibraryView) {
    setView(view);
    setTabState((prev) => ({ ...prev, activeTabId: "home" }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
          Views
        </span>
        {VIEW_ENTRIES.map((v) => (
          <button
            key={v.id}
            onClick={() => selectView(v.id)}
            className={cn(
              "rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
              activeView === v.id
                ? "bg-white/[0.08] text-foreground"
                : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {drafts.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            Drafts
          </span>
          {drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => openDraft(d.id)}
              className="truncate rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
            >
              {d.kind.type === "memo"
                ? d.body.slice(0, 40) || "Empty memo"
                : (d.kind.title ?? `Untitled ${d.kind.type}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
