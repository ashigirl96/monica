import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { type SpaceId, activeSpaceAtom, sidebarOpenAtom } from "@/stores/space";
import { createTabAtom, closeTabAtom, cycleTabAtom } from "@/stores/tabs";
import {
  createRunspaceAtom,
  createTerminalTabAtom,
  closeTerminalTabAtom,
  cycleTerminalTabAtom,
  cycleRunspaceAtom,
  jumpHintsActiveAtom,
  jumpToHintAtom,
  toggleLastRunspaceAtom,
} from "@/stores/terminal";
import { promoteActiveTabRunAtom } from "@/stores/workboard";
import { isEditable } from "@/lib/keyboard";
import { forceSyncPullRequests, onPrSyncCompleted } from "@/commands/pull_request";
import { pushErrorToast } from "@/stores/toast";

const META_KEY_SPACE_MAP: Record<string, SpaceId> = {
  "1": "dashboard",
  "2": "project",
  "3": "work-board",
  "4": "work-bench",
};

const PREFIX_TIMEOUT = 2000;

export function useShortcuts() {
  const activeSpace = useAtomValue(activeSpaceAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
  const setSidebarOpen = useSetAtom(sidebarOpenAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const cycleTab = useSetAtom(cycleTabAtom);
  const createRunspace = useSetAtom(createRunspaceAtom);
  const createTerminalTab = useSetAtom(createTerminalTabAtom);
  const closeTerminalTab = useSetAtom(closeTerminalTabAtom);
  const cycleTerminalTab = useSetAtom(cycleTerminalTabAtom);
  const cycleRunspace = useSetAtom(cycleRunspaceAtom);
  const promoteActiveTabRun = useSetAtom(promoteActiveTabRunAtom);
  const jumpActive = useAtomValue(jumpHintsActiveAtom);
  const setJumpActive = useSetAtom(jumpHintsActiveAtom);
  const jumpToHint = useSetAtom(jumpToHintAtom);
  const toggleLastRunspace = useSetAtom(toggleLastRunspaceAtom);

  const timeoutRef = useRef<number>(0);
  const prSyncInFlightRef = useRef(false);
  const prevActiveSpaceRef = useRef(activeSpace);

  useEffect(() => {
    const unlisten = onPrSyncCompleted(() => {
      prSyncInFlightRef.current = false;
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (prevActiveSpaceRef.current === "work-bench" && activeSpace !== "work-bench") {
      setJumpActive(false);
      clearTimeout(timeoutRef.current);
    }
    prevActiveSpaceRef.current = activeSpace;
  }, [activeSpace, setJumpActive]);

  useEffect(() => {
    if (activeSpace !== "work-bench" || !jumpActive) return;

    function dismissJumpMode() {
      setJumpActive(false);
      clearTimeout(timeoutRef.current);
    }

    window.addEventListener("pointerdown", dismissJumpMode, true);
    return () => window.removeEventListener("pointerdown", dismissJumpMode, true);
  }, [activeSpace, jumpActive, setJumpActive]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isWorkBench = activeSpace === "work-bench";
      const editable = isEditable(e);

      if (jumpActive) {
        if (e.key === "Alt" || e.key === "Control" || e.key === "Meta" || e.key === "Shift") {
          return;
        }
        e.preventDefault();
        clearTimeout(timeoutRef.current);
        if (e.ctrlKey && e.key === "t") {
          setJumpActive(false);
          return;
        }
        if (e.key === "c" && !e.ctrlKey) {
          setJumpActive(false);
          if (isWorkBench) {
            createTerminalTab();
          } else {
            createTab();
          }
          return;
        }
        if (!isWorkBench) {
          setJumpActive(false);
          return;
        }
        // Ctrl+digit → runspace, bare digit → tab. Unmatched keys (Escape included)
        // just dismiss the hints.
        jumpToHint({ key: e.key.toLowerCase(), runspace: e.ctrlKey });
        return;
      }

      if (e.metaKey && e.key === "0") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (e.metaKey && e.key in META_KEY_SPACE_MAP) {
        e.preventDefault();
        setActiveSpace(META_KEY_SPACE_MAP[e.key]);
        return;
      }

      // Stays above the editable guard: the terminal focuses xterm's hidden textarea.
      if (e.metaKey && e.key === "g") {
        e.preventDefault();
        if (isWorkBench) void promoteActiveTabRun();
        return;
      }

      if (e.metaKey && e.key === "r") {
        e.preventDefault();
        if (activeSpace === "work-board" && !prSyncInFlightRef.current) {
          prSyncInFlightRef.current = true;
          void forceSyncPullRequests().catch((err) => {
            pushErrorToast(err instanceof Error ? err.message : String(err));
            prSyncInFlightRef.current = false;
          });
        }
        return;
      }

      if (e.altKey && e.code === "KeyP") {
        e.preventDefault();
        if (isWorkBench) createRunspace();
        return;
      }

      if (e.altKey && e.code === "KeyO") {
        e.preventDefault();
        if (isWorkBench) toggleLastRunspace();
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
        setJumpActive(true);
        clearTimeout(timeoutRef.current);
        // Outside the WorkBench there is no hint UI, so expire the prefix like before.
        if (!isWorkBench) {
          timeoutRef.current = window.setTimeout(() => setJumpActive(false), PREFIX_TIMEOUT);
        }
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
    setActiveSpace,
    setSidebarOpen,
    createTab,
    closeTab,
    cycleTab,
    createRunspace,
    createTerminalTab,
    closeTerminalTab,
    cycleTerminalTab,
    cycleRunspace,
    promoteActiveTabRun,
    jumpActive,
    setJumpActive,
    jumpToHint,
    toggleLastRunspace,
  ]);
}
