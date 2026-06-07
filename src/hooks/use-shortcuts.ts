import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { sidebarOpenAtom } from "@/stores/space";
import { createTabAtom, closeTabAtom, cycleTabAtom } from "@/stores/tabs";

const PREFIX_TIMEOUT = 2000;

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

function isEditable(e: KeyboardEvent): boolean {
  const el = e.target;
  return el instanceof HTMLElement && el.closest(EDITABLE_SELECTOR) !== null;
}

export function useShortcuts() {
  const setSidebarOpen = useSetAtom(sidebarOpenAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const cycleTab = useSetAtom(cycleTabAtom);

  const prefixRef = useRef(false);
  const timeoutRef = useRef<number>(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditable(e)) return;

      if (prefixRef.current) {
        prefixRef.current = false;
        clearTimeout(timeoutRef.current);
        if (e.key === "c") {
          e.preventDefault();
          createTab();
        }
        return;
      }

      if (e.metaKey && e.key === "1") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        prefixRef.current = true;
        timeoutRef.current = window.setTimeout(() => {
          prefixRef.current = false;
        }, PREFIX_TIMEOUT);
        return;
      }

      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        closeTab();
        return;
      }

      if (e.altKey && e.code === "KeyH") {
        e.preventDefault();
        cycleTab("left");
        return;
      }

      if (e.altKey && e.code === "KeyL") {
        e.preventDefault();
        cycleTab("right");
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(timeoutRef.current);
    };
  }, [setSidebarOpen, createTab, closeTab, cycleTab]);
}
