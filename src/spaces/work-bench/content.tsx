import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  terminalStateAtom,
  terminalReadyAtom,
  closeTerminalTabAtom,
  updateTabTitleAtom,
  updateTabCwdAtom,
  loadTerminalStateAtom,
  saveTerminalStateAtom,
} from "@/stores/terminal";
import { useTerminal } from "./use-terminal";

function TerminalPane({ tabId, cwd, active }: { tabId: string; cwd: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const updateTitle = useSetAtom(updateTabTitleAtom);
  const updateCwd = useSetAtom(updateTabCwdAtom);

  const onTitleChange = useCallback(
    (title: string) => {
      updateTitle(tabId, title);
      if (title.startsWith("/") || title.startsWith("~")) {
        updateCwd(tabId, title);
      }
    },
    [tabId, updateTitle, updateCwd],
  );
  const onCwdChange = useCallback((cwd: string) => updateCwd(tabId, cwd), [tabId, updateCwd]);
  const onExit = useCallback(() => closeTab(tabId), [tabId, closeTab]);

  useTerminal(containerRef, {
    tabId,
    cwd,
    active,
    onTitleChange,
    onCwdChange,
    onExit,
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{
        background: "#222436",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    />
  );
}

export default function WorkBenchContent() {
  const ready = useAtomValue(terminalReadyAtom);
  const state = useAtomValue(terminalStateAtom);
  const loadState = useSetAtom(loadTerminalStateAtom);
  const saveState = useSetAtom(saveTerminalStateAtom);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const prevStateRef = useRef(state);
  useEffect(() => {
    if (!ready) return;
    if (prevStateRef.current !== state) {
      prevStateRef.current = state;
      saveState();
    }
  }, [ready, state, saveState]);

  if (!ready || !state) return null;

  return (
    <div className="relative h-full">
      {state.workspaces.flatMap((ws) =>
        ws.tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            active={ws.id === state.activeWorkspaceId && tab.id === ws.activeTabId}
          />
        )),
      )}
    </div>
  );
}
