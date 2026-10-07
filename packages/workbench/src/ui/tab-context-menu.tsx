import { PopoverMenu, PopoverMenuItem } from '@tania/ui'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ReactNode } from 'react'

import {
  startNewShellForTabAtom,
  tabMenuAtom,
  type TabMenuState,
  tabMenuTabAtom,
  toggleTabPinAtom,
} from './store.ts'
import { isDeadStatus, terminalSessionStatusAtom } from './terminal-sessions.ts'

export type MenuTab = {
  id: string
  terminalSessionId: string
}

export type TabMenuItems = (tab: MenuTab, close: () => void) => ReactNode

export function TabContextMenu({ tabMenuItems }: { tabMenuItems?: TabMenuItems }) {
  const menu = useAtomValue(tabMenuAtom)
  if (menu === null) return null
  return <MenuPopover menu={menu} tabMenuItems={tabMenuItems} />
}

function MenuPopover({ menu, tabMenuItems }: { menu: TabMenuState; tabMenuItems?: TabMenuItems }) {
  const setMenu = useSetAtom(tabMenuAtom)
  const startNewShell = useSetAtom(startNewShellForTabAtom)
  const togglePin = useSetAtom(toggleTabPinAtom)
  const tab = useAtomValue(tabMenuTabAtom)
  const statuses = useAtomValue(terminalSessionStatusAtom)

  if (!tab) return null

  const dead = isDeadStatus(statuses[tab.terminalSessionId]?.status)
  const close = () => setMenu(null)

  return (
    <PopoverMenu anchor={menu.anchor} onClose={close}>
      <PopoverMenuItem
        onClick={() => {
          close()
          void togglePin(menu.tabId)
        }}
      >
        {tab.pinned ? 'Unpin' : 'Pin'}
      </PopoverMenuItem>
      <PopoverMenuItem
        disabled={!dead}
        onClick={() => {
          close()
          void startNewShell(menu.tabId)
        }}
      >
        New shell here
      </PopoverMenuItem>
      {tabMenuItems?.({ id: tab.id, terminalSessionId: tab.terminalSessionId }, close)}
    </PopoverMenu>
  )
}
