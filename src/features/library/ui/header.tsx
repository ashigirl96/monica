import { useAtomValue, useSetAtom } from "jotai";
import {
  libraryViewAtom,
  libraryTabStateAtom,
  activeLibraryTabAtom,
  activateLibraryTabAtom,
  closeLibraryTabAtom,
} from "@/features/library/store";
import { cn } from "@/lib/utils";
import { XIcon } from "@/components/icons";

const VIEW_LABELS: Record<string, string> = {
  timeline: "Timeline",
  essay: "Essay",
  intent: "Intent",
};

export function LibraryHeader() {
  const view = useAtomValue(libraryViewAtom);
  const tabState = useAtomValue(libraryTabStateAtom);
  const activeTab = useAtomValue(activeLibraryTabAtom);
  const activateTab = useSetAtom(activateLibraryTabAtom);
  const closeTab = useSetAtom(closeLibraryTabAtom);

  return (
    <div className="flex min-w-0 items-center gap-0.5" data-tauri-drag-region>
      {tabState.tabs.map((tab) => {
        const isActive = tab.id === activeTab.id;
        const label =
          tab.kind === "home"
            ? (VIEW_LABELS[view] ?? view)
            : tab.kind === "draft"
              ? "Draft"
              : tab.artifactId;
        const isClosable = tab.kind !== "home";

        return (
          <button
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            className={cn(
              "group flex max-w-40 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors",
              isActive
                ? "bg-white/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{label}</span>
            {isClosable && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="flex-shrink-0 rounded opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-60"
              >
                <XIcon size={12} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
