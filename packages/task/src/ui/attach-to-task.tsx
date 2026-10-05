import {
  type PopoverAnchor,
  PopoverMenu,
  PopoverMenuItem,
  PopoverMenuSeparator,
  pushErrorToast,
} from '@tania/ui'
import type { MenuTab, TabMenuItems } from '@tania/workbench/ui'
import { useCallback, useEffect, useState } from 'react'

import type { CurrentOutput, ListItem } from '../contract.ts'
import { taskLabel } from '../label.ts'
import { stateText } from '../state-text.ts'
import { attachChoices } from './attach-choices.ts'
import type { TaskClient } from './runspace-labels.tsx'

export function useTabMenuItems(client: TaskClient | null): TabMenuItems {
  return useCallback(
    (tab, close) => client && <AttachToTask client={client} tab={tab} close={close} />,
    [client],
  )
}

// 項目を出すかは Tab の claude がどの Task の Run かで決まるので、メニューを開くたびに読む。
function AttachToTask({
  client,
  tab,
  close,
}: {
  client: TaskClient
  tab: MenuTab
  close: () => void
}) {
  const [choices, setChoices] = useState<ListItem[] | null>(null)
  const [picker, setPicker] = useState<PopoverAnchor | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    Promise.all([
      client.list({}, { signal }),
      taskOfTab(client, tab.terminalSessionId, signal),
    ]).then(
      ([listed, tabTask]) => setChoices(attachChoices(listed.tasks, tabTask)),
      (error: unknown) => {
        if (!signal.aborted) console.warn('task list failed:', error)
      },
    )
    return () => controller.abort()
  }, [client, tab.terminalSessionId])

  if (!choices) return null

  async function attach(ref: string) {
    close()
    try {
      await client.attach({ ref, terminalSessionId: tab.terminalSessionId })
    } catch (error) {
      pushErrorToast(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      <PopoverMenuSeparator />
      <PopoverMenuItem
        onClick={(e) => {
          const { top, bottom, left } = e.currentTarget.getBoundingClientRect()
          setPicker({ top, bottom, left })
        }}
      >
        Attach to Task…
      </PopoverMenuItem>
      {picker && (
        <PopoverMenu
          anchor={picker}
          onClose={() => setPicker(null)}
          className="max-h-80 w-80 overflow-y-auto"
        >
          {choices.length === 0 ? (
            <div className="px-2 py-1 text-[12px] text-muted-foreground">No open Tasks</div>
          ) : (
            choices.map((choice) => (
              <PopoverMenuItem
                key={choice.ref}
                onClick={() => void attach(choice.ref)}
                className="gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  {taskLabel(choice.ref, choice.title)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {stateText(choice.displayState)}
                </span>
              </PopoverMenuItem>
            ))
          )}
        </PopoverMenu>
      )}
    </>
  )
}

// Tab の claude がどの Run でもなく、Tab が Bench にも無ければ、current は NOT_FOUND で答える。
function taskOfTab(
  client: TaskClient,
  terminalSessionId: string,
  signal: AbortSignal,
): Promise<CurrentOutput | null> {
  return client.current({ terminalSessionId }, { signal }).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'NOT_FOUND'
    ) {
      return null
    }
    throw error
  })
}
