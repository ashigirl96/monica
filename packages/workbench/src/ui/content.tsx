import { useCallback, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { jumpHintsActiveAtom } from "./jump-hints.ts";
import { baseName } from "./paths.ts";
import {
  type TerminalSessionStatus,
  type TerminalSessionStatusEntry,
  terminalSessionStatusAtom,
} from "./terminal-sessions.ts";
import {
  activeTerminalTabAtom,
  closeTerminalTabAtom,
  deadTabsAtom,
  layoutAtom,
  startNewShellForTabAtom,
  tabExitedAtom,
  updateTabCwdAtom,
  updateTabTitleAtom,
} from "./store.ts";
import { TabContextMenu } from "./tab-context-menu.tsx";
import { uiZoomAtom } from "./ui-state.ts";
import { useTerminal } from "./use-terminal.ts";

function TerminalSessionOverlay({
  entry,
  cwd,
  onNewShell,
  onCloseTab,
}: {
  entry: TerminalSessionStatusEntry;
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
          {entry.status === "failed" ? "Retry" : `New shell in ${baseName(cwd)}`}
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
  terminalSessionId,
  status,
  dead,
  cwd,
  active,
}: {
  tabId: string;
  terminalSessionId: string;
  status?: TerminalSessionStatus;
  dead?: TerminalSessionStatusEntry;
  cwd: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const startNewShell = useSetAtom(startNewShellForTabAtom);
  const tabExited = useSetAtom(tabExitedAtom);
  const updateTitle = useSetAtom(updateTabTitleAtom);
  const updateCwd = useSetAtom(updateTabCwdAtom);

  const onTitleChange = useCallback(
    (title: string) => void updateTitle(tabId, title),
    [tabId, updateTitle],
  );
  const onCwdChange = useCallback((cwd: string) => void updateCwd(tabId, cwd), [tabId, updateCwd]);
  const onExit = useCallback(
    (exitCode: number | null) => void tabExited(tabId, exitCode),
    [tabId, tabExited],
  );

  useTerminal(containerRef, {
    tabId,
    sessionId: terminalSessionId,
    sessionStatus: status,
    cwd,
    active,
    onTitleChange,
    onCwdChange,
    onExit,
  });

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
        <TerminalSessionOverlay
          entry={dead}
          cwd={cwd}
          onNewShell={() => void startNewShell(tabId)}
          onCloseTab={() => void closeTab(tabId)}
        />
      )}
    </div>
  );
}

export default function WorkbenchContent() {
  const layout = useAtomValue(layoutAtom);
  const activeTabId = useAtomValue(activeTerminalTabAtom)?.id;
  const statuses = useAtomValue(terminalSessionStatusAtom);
  const deadTabs = useAtomValue(deadTabsAtom);
  const uiZoom = useAtomValue(uiZoomAtom);

  if (!layout) return null;

  // Cancel the content region's CSS zoom so the terminal renders at net 1.0 and keeps its
  // own px font control. The content slot holds only terminals; the tab bar and runspace
  // list live in the chrome, which is never zoomed.
  // Panes are keyed and ordered by id, so reordering or moving a Tab never remounts its terminal.
  return (
    <div className="relative h-full" style={{ zoom: 1 / uiZoom }}>
      {layout.runspaces
        .flatMap((runspace) => runspace.tabs)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((tab) => (
          <TerminalPane
            key={tab.id}
            tabId={tab.id}
            terminalSessionId={tab.terminalSessionId}
            status={statuses[tab.terminalSessionId]?.status}
            dead={deadTabs[tab.id]}
            cwd={tab.cwd}
            active={tab.id === activeTabId}
          />
        ))}
      <JumpOverlay />
      <TabContextMenu />
    </div>
  );
}
