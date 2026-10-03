import {
  createRunspaceAtom,
  createTerminalTabAtom,
  cycleRunspaceAtom,
  cycleTerminalTabAtom,
  handleJumpMode,
  jumpHintsActiveAtom,
  jumpToHintAtom,
  type JumpModeActions,
  moveActiveRunspaceAtom,
  moveActiveTabAtom,
  setUiZoomAtom,
  sidebarOpenAtom,
  toggleTabPinAtom,
} from "@tania/workbench/ui";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

type KeyBinding = {
  key?: string;
  keys?: string[];
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  editable?: boolean;
  action: (e: KeyboardEvent) => void | false;
};

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

function isEditable(e: KeyboardEvent): boolean {
  const el = e.target;
  return el instanceof HTMLElement && el.closest(EDITABLE_SELECTOR) !== null;
}

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
  const setSidebarOpen = useSetAtom(sidebarOpenAtom);
  const createRunspace = useSetAtom(createRunspaceAtom);
  const createTerminalTab = useSetAtom(createTerminalTabAtom);
  const cycleTerminalTab = useSetAtom(cycleTerminalTabAtom);
  const cycleRunspace = useSetAtom(cycleRunspaceAtom);
  const jumpActive = useAtomValue(jumpHintsActiveAtom);
  const setJumpActive = useSetAtom(jumpHintsActiveAtom);
  const jumpToHint = useSetAtom(jumpToHintAtom);
  const moveActiveTab = useSetAtom(moveActiveTabAtom);
  const moveActiveRunspace = useSetAtom(moveActiveRunspaceAtom);
  const setUiZoom = useSetAtom(setUiZoomAtom);
  const toggleTabPin = useSetAtom(toggleTabPinAtom);

  useEffect(() => {
    if (!jumpActive) return;
    const dismissJumpMode = () => setJumpActive(false);
    window.addEventListener("pointerdown", dismissJumpMode, true);
    return () => window.removeEventListener("pointerdown", dismissJumpMode, true);
  }, [jumpActive, setJumpActive]);

  useEffect(() => {
    const bindings: KeyBinding[] = [
      { alt: true, code: "KeyP", editable: true, action: () => void createRunspace() },
      { alt: true, code: "KeyJ", editable: true, action: () => cycleRunspace("down") },
      { alt: true, code: "KeyK", editable: true, action: () => cycleRunspace("up") },
      {
        ctrl: true,
        key: "Tab",
        editable: true,
        action: (e) => cycleTerminalTab(e.shiftKey ? "left" : "right"),
      },
      {
        ctrl: true,
        key: "t",
        editable: true,
        action: () => setJumpActive(true),
      },
      { meta: true, key: "b", editable: true, action: () => setSidebarOpen((v) => !v) },
      // macOS の印刷ダイアログは preventDefault で抑えられる。
      { meta: true, shift: false, key: "p", editable: true, action: () => void toggleTabPin() },
      { meta: true, keys: ["=", "+"], action: () => setUiZoom("in") },
      { meta: true, key: "-", action: () => setUiZoom("out") },
      { alt: true, code: "KeyH", action: () => cycleTerminalTab("left") },
      { alt: true, code: "KeyL", action: () => cycleTerminalTab("right") },
    ];

    function onKeyDown(e: KeyboardEvent) {
      if (jumpActive) {
        const actions: JumpModeActions = {
          deactivate: () => setJumpActive(false),
          createTab: () => void createTerminalTab(),
          jumpToHint,
          moveActiveTab: (direction) => void moveActiveTab(direction),
          moveActiveRunspace: (direction) => void moveActiveRunspace(direction),
        };
        handleJumpMode(e, actions);
        return;
      }
      if (e.metaKey && e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setUiZoom("reset");
        return;
      }
      const skipNonEditable = isEditable(e) && !e.altKey;
      for (const binding of bindings) {
        if (skipNonEditable && !binding.editable) continue;
        if (matchBinding(binding, e)) {
          if (binding.action(e) !== false) e.preventDefault();
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setSidebarOpen,
    createRunspace,
    createTerminalTab,
    cycleTerminalTab,
    cycleRunspace,
    jumpActive,
    setJumpActive,
    jumpToHint,
    moveActiveTab,
    moveActiveRunspace,
    setUiZoom,
    toggleTabPin,
  ]);
}
