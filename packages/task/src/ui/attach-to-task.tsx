import {
  type PopoverAnchor,
  PopoverMenu,
  PopoverMenuItem,
  PopoverMenuSeparator,
  pushErrorToast,
} from "@tania/ui";
import type { MenuTab, TabMenuItems } from "@tania/workbench/ui";
import { useCallback, useEffect, useState } from "react";
import type { ListItem } from "../contract.ts";
import { taskLabel } from "../label.ts";
import { stateText } from "../state-text.ts";
import { attachChoices } from "./attach-choices.ts";
import type { TaskClient } from "./runspace-labels.tsx";

export function useTabMenuItems(client: TaskClient | null): TabMenuItems {
  return useCallback(
    (tab, close) => client && <AttachToTask client={client} tab={tab} close={close} />,
    [client],
  );
}

// 項目を出すかは task.list の liveRuns で決まるので、メニューを開くたびに読む。
function AttachToTask({
  client,
  tab,
  close,
}: {
  client: TaskClient;
  tab: MenuTab;
  close: () => void;
}) {
  const [tasks, setTasks] = useState<ListItem[] | null>(null);
  const [picker, setPicker] = useState<PopoverAnchor | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.list({}, { signal: controller.signal }).then(
      (listed) => setTasks(listed.tasks),
      (error: unknown) => {
        if (!controller.signal.aborted) console.warn("task list failed:", error);
      },
    );
    return () => controller.abort();
  }, [client]);

  const choices = tasks && attachChoices(tasks, tab.liveAgentSessionId);
  if (!choices) return null;

  async function attach(ref: string) {
    close();
    try {
      await client.attach({ ref, terminalSessionId: tab.terminalSessionId });
    } catch (error) {
      pushErrorToast(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <PopoverMenuSeparator />
      <PopoverMenuItem
        onClick={(e) => {
          const { top, bottom, left } = e.currentTarget.getBoundingClientRect();
          setPicker({ top, bottom, left });
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
  );
}
