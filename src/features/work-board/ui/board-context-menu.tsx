import { useAtomValue, useSetAtom } from "jotai";
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { PopoverMenu } from "@/components/popover-menu";
import { taskSummariesAtom } from "@/stores/workboard";
import {
  MENU_ITEMS,
  executeMenuItemAtom,
  isItemDisabled,
  menuAtom,
  setMenuItemIndexAtom,
  type MenuState,
} from "@/stores/workboard-nav";

export function BoardContextMenu() {
  const menu = useAtomValue(menuAtom);
  if (menu === null) return null;
  return <MenuPopover menu={menu} />;
}

function MenuPopover({ menu }: { menu: MenuState }) {
  const setMenu = useSetAtom(menuAtom);
  const setItemIndex = useSetAtom(setMenuItemIndexAtom);
  const executeItem = useSetAtom(executeMenuItemAtom);
  const task = useAtomValue(taskSummariesAtom).find((t) => t.id === menu.taskId);

  if (!task) return null;

  return (
    <PopoverMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
      {MENU_ITEMS.map((item, i) => {
        const disabled = isItemDisabled(item.id, task);
        const selected = i === menu.itemIndex;
        const isClose = item.id === "close";
        return (
          <Fragment key={item.id}>
            {isClose && <div className="my-1 h-px bg-border" />}
            <button
              type="button"
              disabled={disabled}
              onMouseEnter={() => setItemIndex(i)}
              onClick={() => executeItem()}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px]",
                isClose ? "text-destructive" : "text-popover-foreground",
                selected && (isClose ? "bg-destructive/15" : "bg-accent text-accent-foreground"),
                disabled && "opacity-40",
              )}
            >
              <span>{isClose && menu.confirmingClose ? "Enter to confirm" : item.label}</span>
              {item.hint && (
                <span className="font-mono text-[10px] text-muted-foreground">{item.hint}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </PopoverMenu>
  );
}
