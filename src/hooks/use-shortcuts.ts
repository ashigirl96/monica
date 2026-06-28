import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { activeSpaceAtom, sidebarOpenAtom } from "@/stores/space";
import type { SpaceId } from "@/stores/space";
import { spaces } from "@/spaces/registry";
import { createTabAtom, closeTabAtom, cycleTabAtom } from "@/stores/tabs";
import {
  createRunspaceAtom,
  createTerminalTabAtom,
  cycleTerminalTabAtom,
  cycleRunspaceAtom,
  jumpHintsActiveAtom,
  jumpToHintAtom,
  planPreviewAtom,
  promoteActiveTabRunAtom,
  toggleLastRunspaceAtom,
  togglePlanPreviewAtom,
} from "@/features/work-bench/store";
import { forceSyncPullRequestsAtom } from "@/stores/pr-sync";
import { newTaskOpenAtom, projectFilterOpenAtom, cycleBoardViewAtom } from "@/stores/workboard";
import { cycleLibraryModeAtom } from "@/stores/library";
import {
  closeNotebookAtom,
  cycleNotebookFocusAtom,
  cyclePageAtom,
  openFocusedNotebookAtom,
  scrollContentByAtom,
  selectedNotebookIdAtom,
} from "@/features/library/store";
import { setUiZoomAtom } from "@/stores/zoom";
import { isEditable } from "@/lib/keyboard";
import { handleJumpMode, type JumpModeActions } from "@/lib/jump-mode";

const META_KEY_SPACE_MAP = Object.fromEntries(spaces.map((s, i) => [String(i + 1), s.id]));

const PREFIX_TIMEOUT = 2000;

type ShortcutContext = {
  e: KeyboardEvent;
  activeSpace: SpaceId;
  isWorkBench: boolean;
};

type KeyBinding = {
  key?: string;
  keys?: string[];
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  editable?: boolean;
  action: (ctx: ShortcutContext) => void | false;
};

function matchBinding(b: KeyBinding, e: KeyboardEvent): boolean {
  if (b.meta && !e.metaKey) return false;
  if (b.ctrl && !e.ctrlKey) return false;
  if (b.alt && !e.altKey) return false;
  if (b.shift && !e.shiftKey) return false;
  if (!b.meta && e.metaKey) return false;
  if (!b.ctrl && e.ctrlKey) return false;
  if (!b.alt && e.altKey) return false;
  if (b.shift === false && e.shiftKey) return false;
  if (b.key !== undefined && e.key !== b.key) return false;
  if (b.keys !== undefined && !b.keys.includes(e.key)) return false;
  if (b.code !== undefined && e.code !== b.code) return false;
  return true;
}

export function useShortcuts() {
  const activeSpace = useAtomValue(activeSpaceAtom);
  const setActiveSpace = useSetAtom(activeSpaceAtom);
  const setSidebarOpen = useSetAtom(sidebarOpenAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const cycleTab = useSetAtom(cycleTabAtom);
  const createRunspace = useSetAtom(createRunspaceAtom);
  const createTerminalTab = useSetAtom(createTerminalTabAtom);
  const cycleTerminalTab = useSetAtom(cycleTerminalTabAtom);
  const cycleRunspace = useSetAtom(cycleRunspaceAtom);
  const promoteActiveTabRun = useSetAtom(promoteActiveTabRunAtom);
  const togglePlanPreview = useSetAtom(togglePlanPreviewAtom);
  const planPreview = useAtomValue(planPreviewAtom);
  const setPlanPreview = useSetAtom(planPreviewAtom);
  const forceSyncPullRequests = useSetAtom(forceSyncPullRequestsAtom);
  const jumpActive = useAtomValue(jumpHintsActiveAtom);
  const setJumpActive = useSetAtom(jumpHintsActiveAtom);
  const jumpToHint = useSetAtom(jumpToHintAtom);
  const toggleLastRunspace = useSetAtom(toggleLastRunspaceAtom);
  const setNewTaskOpen = useSetAtom(newTaskOpenAtom);
  const setProjectFilterOpen = useSetAtom(projectFilterOpenAtom);
  const cycleBoardView = useSetAtom(cycleBoardViewAtom);
  const cycleLibraryMode = useSetAtom(cycleLibraryModeAtom);
  const cyclePage = useSetAtom(cyclePageAtom);
  const scrollContent = useSetAtom(scrollContentByAtom);
  const cycleNotebookFocus = useSetAtom(cycleNotebookFocusAtom);
  const openFocusedNotebook = useSetAtom(openFocusedNotebookAtom);
  const closeNotebook = useSetAtom(closeNotebookAtom);
  const selectedNotebookId = useAtomValue(selectedNotebookIdAtom);
  const setUiZoom = useSetAtom(setUiZoomAtom);

  const timeoutRef = useRef<number>(0);

  useEffect(() => {
    if (activeSpace !== "work-bench") {
      setJumpActive(false);
      clearTimeout(timeoutRef.current);
      setPlanPreview(null);
    }
  }, [activeSpace, setJumpActive, setPlanPreview]);

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
    function cycleFocusedTab(direction: "left" | "right", isWorkBench: boolean) {
      if (isWorkBench) cycleTerminalTab(direction);
      else cycleTab(direction);
    }

    const bindings: KeyBinding[] = [
      {
        meta: true,
        shift: false,
        key: "n",
        editable: true,
        action: ({ activeSpace: space }) => {
          if (space !== "work-board") setActiveSpace("work-board");
          setNewTaskOpen(true);
        },
      },
      {
        meta: true,
        key: "g",
        editable: true,
        action: ({ isWorkBench }) => {
          if (isWorkBench) void promoteActiveTabRun();
        },
      },
      {
        meta: true,
        key: "e",
        editable: true,
        action: ({ isWorkBench }) => {
          if (!isWorkBench) return false;
          void togglePlanPreview();
        },
      },
      {
        meta: true,
        key: "r",
        editable: true,
        action: ({ activeSpace: space }) => {
          if (space === "work-board") void forceSyncPullRequests();
        },
      },
      {
        alt: true,
        code: "KeyP",
        editable: true,
        action: ({ isWorkBench }) => {
          if (isWorkBench) createRunspace();
        },
      },
      {
        alt: true,
        code: "KeyO",
        editable: true,
        action: ({ isWorkBench }) => {
          if (isWorkBench) toggleLastRunspace();
        },
      },
      {
        alt: true,
        code: "KeyJ",
        editable: true,
        action: ({ isWorkBench, activeSpace: space }) => {
          if (isWorkBench) cycleRunspace("down");
          else if (space === "work-board") cycleBoardView("down");
          else if (space === "library") {
            if (selectedNotebookId === null) cycleNotebookFocus("next");
            else cyclePage("next");
          }
        },
      },
      {
        alt: true,
        code: "KeyK",
        editable: true,
        action: ({ isWorkBench, activeSpace: space }) => {
          if (isWorkBench) cycleRunspace("up");
          else if (space === "work-board") cycleBoardView("up");
          else if (space === "library") {
            if (selectedNotebookId === null) cycleNotebookFocus("prev");
            else cyclePage("prev");
          }
        },
      },
      {
        ctrl: true,
        key: "Tab",
        editable: true,
        action: ({ e, isWorkBench }) => {
          cycleFocusedTab(e.shiftKey ? "left" : "right", isWorkBench);
        },
      },
      {
        ctrl: true,
        key: "t",
        editable: true,
        action: ({ isWorkBench }) => {
          setJumpActive(true);
          clearTimeout(timeoutRef.current);
          if (!isWorkBench) {
            timeoutRef.current = window.setTimeout(() => setJumpActive(false), PREFIX_TIMEOUT);
          }
        },
      },
      {
        ctrl: true,
        key: "w",
        editable: true,
        action: ({ activeSpace: space }) => {
          if (space === "work-board") setProjectFilterOpen((v) => !v);
        },
      },
      {
        ctrl: true,
        key: "q",
        editable: true,
        action: ({ activeSpace: space }) => {
          if (space === "library") cycleLibraryMode("down");
        },
      },
      {
        key: "Escape",
        editable: true,
        action: ({ activeSpace: space, isWorkBench }) => {
          if (isWorkBench && planPreview) {
            setPlanPreview(null);
            return;
          }
          if (space !== "library" || selectedNotebookId === null) return false;
          closeNotebook();
        },
      },
      {
        key: "Enter",
        action: ({ activeSpace: space }) => {
          if (space !== "library" || selectedNotebookId !== null) return false;
          openFocusedNotebook();
        },
      },
      {
        meta: true,
        key: "b",
        editable: true,
        action: () => {
          setSidebarOpen((v) => !v);
        },
      },
      {
        meta: true,
        keys: ["=", "+"],
        action: () => {
          setUiZoom("in");
        },
      },
      {
        meta: true,
        key: "-",
        action: () => {
          setUiZoom("out");
        },
      },
      {
        ctrl: true,
        key: "d",
        action: ({ isWorkBench }) => {
          if (isWorkBench) return false;
          closeTab();
        },
      },
      {
        alt: true,
        code: "KeyH",
        action: ({ isWorkBench, activeSpace: space }) => {
          if (space === "library") {
            if (selectedNotebookId === null) return false;
            closeNotebook();
          } else {
            cycleFocusedTab("left", isWorkBench);
          }
        },
      },
      {
        alt: true,
        code: "KeyL",
        action: ({ isWorkBench, activeSpace: space }) => {
          if (space === "library") {
            if (selectedNotebookId !== null) return false;
            openFocusedNotebook();
          } else {
            cycleFocusedTab("right", isWorkBench);
          }
        },
      },
      {
        key: "j",
        action: ({ activeSpace: space }) => {
          if (space !== "library") return false;
          scrollContent("down");
        },
      },
      {
        key: "k",
        action: ({ activeSpace: space }) => {
          if (space !== "library") return false;
          scrollContent("up");
        },
      },
    ];

    function onKeyDown(e: KeyboardEvent) {
      const isWorkBench = activeSpace === "work-bench";

      if (jumpActive) {
        const actions: JumpModeActions = {
          clearTimeout: () => clearTimeout(timeoutRef.current),
          deactivate: () => setJumpActive(false),
          createTab: () => (isWorkBench ? createTerminalTab() : createTab()),
          jumpToHint,
        };
        handleJumpMode(e, isWorkBench, actions);
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

      const ctx: ShortcutContext = { e, activeSpace, isWorkBench };
      const skipNonEditable = isEditable(e) && !e.altKey;

      for (const binding of bindings) {
        if (skipNonEditable && !binding.editable) continue;
        if (matchBinding(binding, e)) {
          if (binding.action(ctx) !== false) e.preventDefault();
          return;
        }
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
    cycleTerminalTab,
    cycleRunspace,
    promoteActiveTabRun,
    togglePlanPreview,
    planPreview,
    setPlanPreview,
    forceSyncPullRequests,
    jumpActive,
    setJumpActive,
    jumpToHint,
    toggleLastRunspace,
    cycleBoardView,
    cycleLibraryMode,
    cyclePage,
    scrollContent,
    cycleNotebookFocus,
    openFocusedNotebook,
    closeNotebook,
    selectedNotebookId,
    setNewTaskOpen,
    setProjectFilterOpen,
    setUiZoom,
  ]);
}
