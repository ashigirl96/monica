import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { readSetupLog } from "@/commands/task";
import { loadBoardAtom } from "@/stores/workboard";
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
  taskId,
  taskRunId,
  active,
}: {
  tabId: string;
  cwd: string;
  taskId: string | undefined;
  taskRunId: string | undefined;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTab = useSetAtom(closeTerminalTabAtom);
  const updateTitle = useSetAtom(updateTabTitleAtom);
  const updateCwd = useSetAtom(updateTabCwdAtom);
  const env = useMemo(() => tabEnv(taskId, taskRunId), [taskId, taskRunId]);

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
    env,
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
        background: "#1d1f21",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    />
  );
}

function SetupLogPane({ taskRunId, active }: { taskRunId: string | undefined; active: boolean }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loadBoard = useSetAtom(loadBoardAtom);

  useEffect(() => {
    if (!active || !taskRunId) return;
    let canceled = false;
    const runId = taskRunId;

    async function load() {
      try {
        const next = await readSetupLog(runId);
        if (!canceled) {
          setBody(next);
          setError(null);
        }
      } catch (e) {
        if (!canceled) setError(e instanceof Error ? e.message : "Failed to read setup log");
      }
    }

    load();
    const timer = window.setInterval(() => {
      load();
      loadBoard();
    }, 1000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [active, taskRunId, loadBoard]);

  return (
    <pre
      className="absolute inset-0 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed"
      style={{
        background: "#1d1f21",
        color: error ? "#cc6666" : "#c5c8c6",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      {error ?? body}
    </pre>
  );
}

function tabEnv(taskId: string | undefined, taskRunId: string | undefined): [string, string][] {
  if (!taskId || !taskRunId) return [];
  return [
    ["MONICA_TASK_ID", taskId],
    ["MONICA_TASK_RUN_ID", taskRunId],
    ["MONICA_ID", taskId],
    ["MONICA_RUN_ID", taskRunId],
  ];
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
        rs.tabs.map((tab) =>
          tab.kind === "setup_log" ? (
            <SetupLogPane
              key={tab.id}
              taskRunId={tab.taskRunId}
              active={rs.id === state.activeRunspaceId && tab.id === rs.activeTabId}
            />
          ) : (
            <TerminalPane
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              taskId={rs.taskId}
              taskRunId={tab.taskRunId}
              active={rs.id === state.activeRunspaceId && tab.id === rs.activeTabId}
            />
          ),
        ),
      )}
    </div>
  );
}
