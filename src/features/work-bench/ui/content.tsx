import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  terminalStateAtom,
  terminalReadyAtom,
  bindTabSessionAtom,
  closeTerminalTabAtom,
  jumpHintsActiveAtom,
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
import { uiZoomAtom } from "@/stores/zoom";
import { clipboardWriteImage } from "@/commands/clipboard";
import { terminalWrite } from "@/commands/terminal";
import { useTerminal } from "./use-terminal";
import { TabContextMenu } from "./tab-context-menu";
import { PlanPreview } from "./plan-preview";

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

// Purely visual: dismissal (keys, pointerdown) is owned by useShortcuts.
function JumpOverlay() {
  const active = useAtomValue(jumpHintsActiveAtom);
  if (!active) return null;

  return (
    <div className="animate-in fade-in absolute inset-0 z-20 flex items-end justify-center bg-black/40 pb-6 duration-150">
      <div className="rounded-full border border-white/10 bg-black/70 px-4 py-1.5 font-mono text-[11px] text-foreground/70 shadow-lg">
        <span className="font-bold text-amber-300">⌃1 ⌃2 …</span> runspace
        <span className="mx-2 text-foreground/30">·</span>
        <span className="font-bold text-amber-300">1 2 …</span> tab
        <span className="mx-2 text-foreground/30">·</span>
        <span className="font-bold text-amber-300">c</span> new tab
        <span className="mx-2 text-foreground/30">·</span>
        esc
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
        // display (not visibility): a hidden box still "intersects", so xterm's
        // IntersectionObserver pause never kicks in and background panes keep
        // rendering every write on the main thread. No box = paused renderer.
        display: active ? undefined : "none",
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
  const uiZoom = useAtomValue(uiZoomAtom);

  if (!ready || !state) return null;

  // Cancel the content region's CSS zoom so the terminal renders at net 1.0 and keeps its
  // own px font control. The Content slot holds only terminals; the bench's tab bar and
  // runspace list live in the chrome (space.header / space.sidebar), which is never zoomed.
  return (
    <div className="relative h-full" style={{ zoom: 1 / uiZoom }}>
      {[...state.runspaces]
        .sort((a, b) => a.id.localeCompare(b.id))
        .flatMap((rs) =>
          [...rs.tabs]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((tab) => (
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
      <JumpOverlay />
      <TabContextMenu />
      <PlanPreview />
    </div>
  );
}
