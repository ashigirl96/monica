import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  closeTerminalTabAtom,
  sessionStatusAtom,
  startNewShellForTabAtom,
  tabByIdAtom,
  tabMenuAtom,
  terminateTabSessionAtom,
  type TabMenuState,
} from "@/features/work-bench/store";

const ANCHOR_GAP = 4;
const VIEWPORT_PADDING = 8;

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
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The anchor rect is captured at open time; measure the menu itself before
  // showing it so it can flip above the tab near the bottom edge.
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
    </div>,
    document.body,
  );
}
