import { cn, PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from "@tania/ui";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { isDeadStatus, terminalSessionStatusAtom } from "./terminal-sessions.ts";
import {
  agentSessionByTerminalSessionAtom,
  closeTerminalTabAtom,
  startNewShellForTabAtom,
  tabMenuAtom,
  type TabMenuState,
  tabMenuTabAtom,
  terminateTabTerminalSessionAtom,
  toggleTabPinAtom,
} from "./store.ts";

export type MenuTab = {
  id: string;
  terminalSessionId: string;
  liveAgentSessionId: string | null;
};

export type TabMenuItems = (tab: MenuTab, close: () => void) => ReactNode;

export function TabContextMenu({ tabMenuItems }: { tabMenuItems?: TabMenuItems }) {
  const menu = useAtomValue(tabMenuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} tabMenuItems={tabMenuItems} />;
}

function MenuPopover({ menu, tabMenuItems }: { menu: TabMenuState; tabMenuItems?: TabMenuItems }) {
  const setMenu = useSetAtom(tabMenuAtom);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const terminate = useSetAtom(terminateTabTerminalSessionAtom);
  const startNewShell = useSetAtom(startNewShellForTabAtom);
  const togglePin = useSetAtom(toggleTabPinAtom);
  const tab = useAtomValue(tabMenuTabAtom);
  const statuses = useAtomValue(terminalSessionStatusAtom);
  const agentSessions = useAtomValue(agentSessionByTerminalSessionAtom);

  if (!tab) return null;

  const dead = isDeadStatus(statuses[tab.terminalSessionId]?.status);
  const close = () => setMenu(null);
  const liveAgentSessionId = agentSessions.get(tab.terminalSessionId)?.sessionId ?? null;

  return (
    <PopoverMenu anchor={menu.anchor} onClose={close}>
      <PopoverMenuItem
        onClick={() => {
          close();
          void togglePin(menu.tabId);
        }}
      >
        {tab.pinned ? "Unpin" : "Pin"}
      </PopoverMenuItem>
      {!tab.pinned && (
        <PopoverMenuItem
          onClick={() => {
            close();
            void closeTab(menu.tabId);
          }}
        >
          Close (keep shell)
        </PopoverMenuItem>
      )}
      <PopoverMenuItem
        disabled={!dead}
        onClick={() => {
          close();
          void startNewShell(menu.tabId);
        }}
      >
        New shell here
      </PopoverMenuItem>
      {tabMenuItems?.(
        { id: tab.id, terminalSessionId: tab.terminalSessionId, liveAgentSessionId },
        close,
      )}
      {!tab.pinned && (
        <>
          <PopoverMenuSeparator />
          <PopoverMenuItem
            disabled={dead}
            onClick={() => {
              if (!menu.confirmingTerminate) {
                setMenu({ ...menu, confirmingTerminate: true });
                return;
              }
              close();
              void terminate(menu.tabId);
            }}
            className={cn(
              "text-destructive hover:bg-destructive/15 hover:text-destructive",
              menu.confirmingTerminate && "bg-destructive/15",
            )}
          >
            {menu.confirmingTerminate ? "Click again to confirm" : "Terminate"}
          </PopoverMenuItem>
        </>
      )}
    </PopoverMenu>
  );
}
