import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { type SpaceId, activeSpaceAtom, prefixActiveAtom, sidebarOpenAtom } from "@/stores/space";
import { createTabAtom, closeTabAtom, cycleTabAtom } from "@/stores/tabs";
import {
  createRunspaceAtom,
  createTerminalTabAtom,
  closeTerminalTabAtom,
  cycleTerminalTabAtom,
  cycleRunspaceAtom,
  openRunspaceWindowAtom,
} from "@/stores/terminal";
import { promoteActiveTabRunAtom } from "@/stores/workboard";
import { isRunspaceWindow } from "@/lib/runspace-window";

const META_KEY_SPACE_MAP: Record<string, SpaceId> = {
  "1": "dashboard",
  "2": "project",
  "3": "work-board",
  "4": "work-bench",
};

const PREFIX_TIMEOUT = 2000;

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

function isEditable(e: KeyboardEvent): boolean {
  const el = e.target;
  return el instanceof HTMLElement && el.closest(EDITABLE_SELECTOR) !== null;
}

export function useShortcuts() {
  const activeSpace = useAtomValue(activeSpaceAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
  const setSidebarOpen = useSetAtom(sidebarOpenAtom);
  const setPrefixActive = useSetAtom(prefixActiveAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const cycleTab = useSetAtom(cycleTabAtom);
  const createRunspace = useSetAtom(createRunspaceAtom);
  const createTerminalTab = useSetAtom(createTerminalTabAtom);
  const closeTerminalTab = useSetAtom(closeTerminalTabAtom);
  const cycleTerminalTab = useSetAtom(cycleTerminalTabAtom);
  const cycleRunspace = useSetAtom(cycleRunspaceAtom);
  const openRunspaceWindow = useSetAtom(openRunspaceWindowAtom);
  const promoteActiveTabRun = useSetAtom(promoteActiveTabRunAtom);
  const satellite = isRunspaceWindow();

  const prefixRef = useRef(false);
  const timeoutRef = useRef<number>(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isWorkBench = activeSpace === "work-bench";
      const editable = isEditable(e);

      if (prefixRef.current) {
        prefixRef.current = false;
        setPrefixActive(false);
        clearTimeout(timeoutRef.current);
        if (e.key === "c") {
          e.preventDefault();
          if (isWorkBench) {
            createTerminalTab();
          } else {
            createTab();
          }
        }
        return;
      }

      if (!satellite && e.metaKey && e.key === "0") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (!satellite && e.metaKey && e.key in META_KEY_SPACE_MAP) {
        e.preventDefault();
        setActiveSpace(META_KEY_SPACE_MAP[e.key]);
        return;
      }

      // Stays above the editable guard: the terminal focuses xterm's hidden textarea.
      if (e.metaKey && e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        if (isWorkBench) openRunspaceWindow();
        return;
      }

      // Stays above the editable guard: the terminal focuses xterm's hidden textarea.
      if (e.metaKey && e.key === "g") {
        e.preventDefault();
        if (isWorkBench) void promoteActiveTabRun();
        return;
      }

      if (e.altKey && e.code === "KeyP") {
        e.preventDefault();
        if (isWorkBench) createRunspace();
        return;
      }

      if (e.altKey && e.code === "KeyJ") {
        e.preventDefault();
        if (isWorkBench) cycleRunspace("down");
        return;
      }

      if (e.altKey && e.code === "KeyK") {
        e.preventDefault();
        if (isWorkBench) cycleRunspace("up");
        return;
      }

      // Stays above the editable guard: the terminal focuses xterm's hidden textarea.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const direction = e.shiftKey ? "left" : "right";
        if (isWorkBench) {
          cycleTerminalTab(direction);
        } else {
          cycleTab(direction);
        }
        return;
      }

      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        prefixRef.current = true;
        setPrefixActive(true);
        timeoutRef.current = window.setTimeout(() => {
          prefixRef.current = false;
          setPrefixActive(false);
        }, PREFIX_TIMEOUT);
        return;
      }

      if (editable && !e.altKey) return;

      if (e.ctrlKey && e.key === "d") {
        if (isWorkBench) return;
        e.preventDefault();
        closeTab();
        return;
      }

      if (e.altKey && e.code === "KeyH") {
        e.preventDefault();
        if (isWorkBench) {
          cycleTerminalTab("left");
        } else {
          cycleTab("left");
        }
        return;
      }

      if (e.altKey && e.code === "KeyL") {
        e.preventDefault();
        if (isWorkBench) {
          cycleTerminalTab("right");
        } else {
          cycleTab("right");
        }
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(timeoutRef.current);
    };
  }, [
    activeSpace,
    satellite,
    setActiveSpace,
    setSidebarOpen,
    setPrefixActive,
    createTab,
    closeTab,
    cycleTab,
    createRunspace,
    createTerminalTab,
    closeTerminalTab,
    cycleTerminalTab,
    cycleRunspace,
    openRunspaceWindow,
    promoteActiveTabRun,
  ]);
}
