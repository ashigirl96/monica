import { cn, PopoverMenu } from "@tania/ui";
import { useAtomValue, useSetAtom } from "jotai";
import { isDeadStatus, terminalSessionStatusAtom } from "./terminal-sessions.ts";
import {
  closeTerminalTabAtom,
  startNewShellForTabAtom,
  tabMenuAtom,
  type TabMenuState,
  tabMenuTabAtom,
  terminateTabTerminalSessionAtom,
} from "./store.ts";

export function TabContextMenu() {
  const menu = useAtomValue(tabMenuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} />;
}

function MenuPopover({ menu }: { menu: TabMenuState }) {
  const setMenu = useSetAtom(tabMenuAtom);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const terminate = useSetAtom(terminateTabTerminalSessionAtom);
  const startNewShell = useSetAtom(startNewShellForTabAtom);
  const tab = useAtomValue(tabMenuTabAtom);
  const statuses = useAtomValue(terminalSessionStatusAtom);

  if (!tab) return null;

  const dead = isDeadStatus(statuses[tab.terminalSessionId]?.status);

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
          void closeTab(menu.tabId);
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
          void startNewShell(menu.tabId);
        }}
        className={itemClass("hover:bg-accent hover:text-accent-foreground", !dead)}
      >
        New shell here
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        disabled={dead}
        onClick={() => {
          if (!menu.confirmingTerminate) {
            setMenu({ ...menu, confirmingTerminate: true });
            return;
          }
          setMenu(null);
          void terminate(menu.tabId);
        }}
        className={cn(
          itemClass("hover:bg-destructive/15", dead),
          "text-destructive",
          menu.confirmingTerminate && "bg-destructive/15",
        )}
      >
        {menu.confirmingTerminate ? "Click again to confirm" : "Terminate"}
      </button>
    </PopoverMenu>
  );
}
