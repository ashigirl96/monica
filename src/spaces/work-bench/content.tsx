import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  terminalStateAtom,
  terminalReadyAtom,
  closeTerminalTabAtom,
  updateTabTitleAtom,
  updateTabCwdAtom,
  loadTerminalStateAtom,
  saveTerminalStateAtom,
} from "@/stores/terminal";
import { clipboardWriteImage } from "@/commands/clipboard";
import { ptyWrite } from "@/commands/pty";
import { useTerminal } from "./use-terminal";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".tiff",
  ".bmp",
]);

const CTRL_V_BASE64 = btoa(String.fromCharCode(0x16));

function TerminalPane({
  tabId,
  cwd,
  active,
  launch,
}: {
  tabId: string;
  cwd: string;
  active: boolean;
  launch?: Parameters<typeof useTerminal>[1]["launch"];
}) {
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
    launch,
    onTitleChange,
    onCwdChange,
    onExit,
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{
        background: "#1d1f21",
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

  const activeTabIdRef = useRef<string | undefined>(undefined);
  activeTabIdRef.current = state?.runspaces.find(
    (rs) => rs.id === state.activeRunspaceId,
  )?.activeTabId;

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const imagePath = event.payload.paths.find((p) => {
        const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
        return IMAGE_EXTENSIONS.has(ext);
      });
      if (!imagePath) return;
      clipboardWriteImage(imagePath).then(() => {
        ptyWrite(tabId, CTRL_V_BASE64);
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!ready || !state) return null;

  return (
    <div className="relative h-full">
      {state.runspaces.flatMap((rs) =>
        rs.tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            launch={tab.launch}
            active={rs.id === state.activeRunspaceId && tab.id === rs.activeTabId}
          />
        )),
      )}
    </div>
  );
}
