import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  terminalStateAtom,
  terminalReadyAtom,
  bindTabSessionAtom,
  closeTerminalTabAtom,
  sessionStatusAtom,
  startNewShellForTabAtom,
  updateTabTitleAtom,
  updateTabCwdAtom,
  consumeTerminalLaunchAtom,
  loadTerminalStateAtom,
  saveTerminalStateAtom,
  type SessionStatusEntry,
  type TerminalLaunchIntent,
} from "@/features/work-bench/store";
import { clipboardWriteImage } from "@/commands/clipboard";
import { terminalWrite } from "@/commands/terminal";
import { useTerminal } from "./use-terminal";
import { TabContextMenu } from "./tab-context-menu";

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

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

function SessionOverlay({
  entry,
  cwd,
  onNewShell,
  onCloseTab,
}: {
  entry: SessionStatusEntry;
  cwd: string;
  onNewShell: () => void;
  onCloseTab: () => void;
}) {
  const message =
    entry.status === "lost"
      ? "Session lost — the daemon or process is gone."
      : entry.status === "failed"
        ? "Failed to start the shell."
        : entry.exitCode !== null && entry.exitCode !== undefined
          ? `Shell exited (code ${entry.exitCode}).`
          : "Shell exited.";

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60">
      <span className="text-sm text-foreground/80">{message}</span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onNewShell}
          className="rounded-md bg-white/10 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-white/20"
        >
          {entry.status === "failed" ? "Retry" : `New shell in ${shortCwd(cwd)}`}
        </button>
        <button
          type="button"
          onClick={onCloseTab}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          Close tab
        </button>
      </div>
    </div>
  );
}

function TerminalPane({
  tabId,
  runspaceId,
  sessionId,
  sessionEntry,
  cwd,
  active,
  env,
  launch,
  onLaunchConsumed,
}: {
  tabId: string;
  runspaceId: string;
  sessionId?: string;
  sessionEntry?: SessionStatusEntry;
  cwd: string;
  active: boolean;
  env?: [string, string][];
  launch?: TerminalLaunchIntent;
  onLaunchConsumed?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const bindSession = useSetAtom(bindTabSessionAtom);
  const startNewShell = useSetAtom(startNewShellForTabAtom);
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
  const onSessionCreated = useCallback(
    (sessionId: string) => bindSession(tabId, sessionId),
    [tabId, bindSession],
  );
  const onExit = useCallback(() => closeTab(tabId), [tabId, closeTab]);

  useTerminal(containerRef, {
    tabId,
    runspaceId,
    sessionId,
    sessionStatus: sessionEntry?.status,
    cwd,
    active,
    env,
    launch,
    onTitleChange,
    onCwdChange,
    onSessionCreated,
    onLaunchConsumed,
    onExit,
  });

  const dead =
    sessionEntry &&
    (sessionEntry.status === "exited" ||
      sessionEntry.status === "lost" ||
      sessionEntry.status === "failed");

  return (
    <div
      className="absolute inset-0"
      style={{
        background: "#1d1f21",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {dead && (
        <SessionOverlay
          entry={sessionEntry}
          cwd={cwd}
          onNewShell={() => startNewShell(tabId)}
          onCloseTab={() => closeTab(tabId)}
        />
      )}
    </div>
  );
}

export default function WorkBenchContent() {
  const ready = useAtomValue(terminalReadyAtom);
  const state = useAtomValue(terminalStateAtom);
  const sessionStatus = useAtomValue(sessionStatusAtom);
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

  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeRs = state?.runspaces.find((rs) => rs.id === state.activeRunspaceId);
  activeSessionIdRef.current = activeRs?.tabs.find((t) => t.id === activeRs.activeTabId)?.sessionId;

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      const imagePath = event.payload.paths.find((p) => {
        const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
        return IMAGE_EXTENSIONS.has(ext);
      });
      if (!imagePath) return;
      clipboardWriteImage(imagePath).then(() => {
        terminalWrite(sessionId, CTRL_V_BASE64);
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const consumeLaunch = useSetAtom(consumeTerminalLaunchAtom);

  if (!ready || !state) return null;

  return (
    <div className="relative h-full">
      {state.runspaces.flatMap((rs) =>
        rs.tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tabId={tab.id}
            runspaceId={rs.id}
            sessionId={tab.sessionId}
            sessionEntry={tab.sessionId ? sessionStatus[tab.sessionId] : undefined}
            cwd={tab.cwd}
            active={rs.id === state.activeRunspaceId && tab.id === rs.activeTabId}
            env={rs.env}
            launch={tab.launch}
            onLaunchConsumed={() => consumeLaunch(tab.id)}
          />
        )),
      )}
      <TabContextMenu />
    </div>
  );
}
