import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { activeSpaceAtom, sidebarOpenAtom } from "@/stores/space";
import { spaces } from "@/spaces/registry";
import { createTabAtom, closeTabAtom, cycleTabAtom } from "@/stores/tabs";
import {
  createRunspaceAtom,
  createTerminalTabAtom,
  closeTerminalTabAtom,
  cycleTerminalTabAtom,
  cycleRunspaceAtom,
  jumpHintsActiveAtom,
  jumpToHintAtom,
  promoteActiveTabRunAtom,
  toggleLastRunspaceAtom,
} from "@/features/work-bench/store";
import { forceSyncPullRequestsAtom } from "@/stores/pr-sync";
import { newTaskOpenAtom, projectFilterOpenAtom } from "@/stores/workboard";
import { setUiZoomAtom } from "@/stores/zoom";
import { isEditable } from "@/lib/keyboard";

const META_KEY_SPACE_MAP = Object.fromEntries(spaces.map((s, i) => [String(i + 1), s.id]));

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
  const forceSyncPullRequests = useSetAtom(forceSyncPullRequestsAtom);
  const jumpActive = useAtomValue(jumpHintsActiveAtom);
  const setJumpActive = useSetAtom(jumpHintsActiveAtom);
  const jumpToHint = useSetAtom(jumpToHintAtom);
  const toggleLastRunspace = useSetAtom(toggleLastRunspaceAtom);
  const setNewTaskOpen = useSetAtom(newTaskOpenAtom);
  const setProjectFilterOpen = useSetAtom(projectFilterOpenAtom);
  const setUiZoom = useSetAtom(setUiZoomAtom);

  const timeoutRef = useRef<number>(0);

  useEffect(() => {
    if (activeSpace !== "work-bench") {
      setJumpActive(false);
      clearTimeout(timeoutRef.current);
    }
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
        jumpToHint({ key: e.key.toLowerCase(), runspace: e.ctrlKey });
        return;
      }

      if (e.metaKey && e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setUiZoom("reset");
        return;
      }

      if (e.metaKey && e.key in META_KEY_SPACE_MAP) {
        e.preventDefault();
        setActiveSpace(META_KEY_SPACE_MAP[e.key]);
        return;
      }

      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        if (activeSpace !== "work-board") setActiveSpace("work-board");
        setNewTaskOpen(true);
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
        if (activeSpace === "work-board") void forceSyncPullRequests();
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
        if (!isWorkBench) {
          timeoutRef.current = window.setTimeout(() => setJumpActive(false), PREFIX_TIMEOUT);
        }
        return;
      }

      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeSpace === "work-board") setProjectFilterOpen((v) => !v);
        return;
      }

      if (editable && !e.altKey) return;

      if (e.metaKey && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (e.metaKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setUiZoom("in");
        return;
      }

      if (e.metaKey && e.key === "-") {
        e.preventDefault();
        setUiZoom("out");
        return;
      }

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
    forceSyncPullRequests,
    jumpActive,
    setJumpActive,
    jumpToHint,
    toggleLastRunspace,
    setNewTaskOpen,
    setProjectFilterOpen,
    setUiZoom,
  ]);
}
