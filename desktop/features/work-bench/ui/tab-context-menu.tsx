import { useAtomValue, useSetAtom } from "jotai";
import { cn } from "@/lib/utils";
import { PopoverMenu } from "@/components/popover-menu";
import {
  closeTerminalTabAtom,
  startNewShellForTabAtom,
  tabByIdAtom,
  tabMenuAtom,
  terminateTabSessionAtom,
  type TabMenuState,
} from "@/features/work-bench/store";
import { sessionStatusAtom } from "@/features/work-bench/session-status";

export function TabContextMenu() {
  const menu = useAtomValue(tabMenuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} />;
}

function MenuPopover({ menu }: { menu: TabMenuState }) {
  const setMenu = useSetAtom(tabMenuAtom);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const terminateSession = useSetAtom(terminateTabSessionAtom);
  const startNewShell = useSetAtom(startNewShellForTabAtom);
  const tab = useAtomValue(tabByIdAtom).get(menu.tabId);
  const sessionStatus = useAtomValue(sessionStatusAtom);

  if (!tab) return null;

  const entry = tab.sessionId ? sessionStatus[tab.sessionId] : undefined;
  const dead =
    entry !== undefined &&
    (entry.status === "exited" || entry.status === "lost" || entry.status === "failed");
  const canTerminate = tab.sessionId !== undefined && !dead;

  const itemClass = (selectedStyle: string, disabled?: boolean) =>
    cn(
      "flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-popover-foreground",
      selectedStyle,
      disabled && "opacity-40",
    );

  return (
    <PopoverMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
      <button
        type="button"
        onClick={() => {
          setMenu(null);
          closeTab(menu.tabId);
        }}
        className={itemClass("hover:bg-accent hover:text-accent-foreground")}
      >
        Close (keep shell)
      </button>
      <button
        type="button"
        disabled={!dead}
        onClick={() => {
          setMenu(null);
          startNewShell(menu.tabId);
        }}
        className={itemClass("hover:bg-accent hover:text-accent-foreground", !dead)}
      >
        New shell here
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        disabled={!canTerminate}
        onClick={() => {
          if (!menu.confirmingTerminate) {
            setMenu({ ...menu, confirmingTerminate: true });
            return;
          }
          setMenu(null);
          void terminateSession(menu.tabId);
        }}
        className={cn(
          itemClass("hover:bg-destructive/15", !canTerminate),
          "text-destructive",
          menu.confirmingTerminate && "bg-destructive/15",
        )}
      >
        {menu.confirmingTerminate ? "Click again to confirm" : "Terminate"}
      </button>
    </PopoverMenu>
  );
}
