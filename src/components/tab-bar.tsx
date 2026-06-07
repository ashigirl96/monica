import { useAtomValue, useSetAtom } from "jotai";
import {
  activeTabsAtom,
  activateTabAtom,
  closeTabAtom,
  createTabAtom,
} from "@/stores/tabs";
import { PlusIcon, XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export function TabBar() {
  const { tabs, activeTabId } = useAtomValue(activeTabsAtom);
  const activateTab = useSetAtom(activateTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const createTab = useSetAtom(createTabAtom);

  return (
    <div className="flex h-full items-center gap-1">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            className={cn(
              "group flex h-7 min-w-[220px] cursor-pointer items-center rounded-lg px-3 text-xs",
              "transition-colors duration-100",
              isActive
                ? "bg-[var(--content-bg)] text-foreground shadow-sm"
                : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground",
            )}
          >
            <span className="flex-1 truncate">{tab.label}</span>
            {tabs.length > 1 && (
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded",
                  "opacity-0 transition-opacity duration-100 group-hover:opacity-100",
                  "hover:bg-white/[0.1]",
                )}
              >
                <XIcon size={10} />
              </span>
            )}
          </button>
        );
      })}
      <button
        onClick={() => createTab()}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        title="New tab (Ctrl+T, C)"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}
