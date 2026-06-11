import { useAtomValue, useSetAtom } from "jotai";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { taskSummariesAtom } from "@/stores/workboard";
import {
  MENU_ITEMS,
  executeMenuItemAtom,
  isItemDisabled,
  menuAtom,
  setMenuItemIndexAtom,
  type MenuState,
} from "@/stores/workboard-nav";

const ANCHOR_GAP = 4;
const VIEWPORT_PADDING = 8;

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
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The anchor rect is captured at open time; measure the menu itself before
  // showing it so it can flip above the card near the bottom edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(menu.anchor.left, VIEWPORT_PADDING),
      window.innerWidth - width - VIEWPORT_PADDING,
    );
    let top = menu.anchor.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - VIEWPORT_PADDING) {
      top = menu.anchor.top - height - ANCHOR_GAP;
    }
    setPos({ top, left });
  }, [menu.anchor]);

  // The menu does not track its anchor; any scroll or resize just closes it.
  useEffect(() => {
    const close = () => setMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener("scroll", close, { capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [setMenu]);

  if (!task) return null;

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      style={
        pos
          ? { top: pos.top, left: pos.left }
          : {
              top: menu.anchor.bottom + ANCHOR_GAP,
              left: menu.anchor.left,
              visibility: "hidden",
            }
      }
    >
      {MENU_ITEMS.map((item, i) => {
        const disabled = isItemDisabled(item.id, task.status);
        const selected = i === menu.itemIndex;
        const isDelete = item.id === "delete";
        return (
          <Fragment key={item.id}>
            {isDelete && <div className="my-1 h-px bg-border" />}
            <button
              type="button"
              disabled={disabled}
              onMouseEnter={() => setItemIndex(i)}
              onClick={() => executeItem()}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[12px]",
                isDelete ? "text-destructive" : "text-popover-foreground",
                selected && (isDelete ? "bg-destructive/15" : "bg-accent text-accent-foreground"),
                disabled && "opacity-40",
              )}
            >
              <span>{isDelete && menu.confirmingDelete ? "Enter to confirm" : item.label}</span>
              {item.hint && (
                <span className="font-mono text-[10px] text-muted-foreground">{item.hint}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>,
    document.body,
  );
}
