import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getDefaultStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { commands } from "./commands/bindings";
import { unwrap } from "./commands/unwrap";
import { initPrSync } from "./stores/pr-sync";
import { queryClient } from "./stores/query-client";
import { initQuerySync } from "./stores/query-sync";
import {
  hydrateUiState,
  windowLabelAtom,
  MAIN_WINDOW_LABEL,
  getSecondaryWindowLabels,
  removeWindowEntry,
  ensureWindowEntry,
} from "./stores/ui-state";
import { initUiStatePersistence } from "./stores/ui-state-persistence";
import { terminalStateAtom } from "./features/work-bench/store";
import { terminalSaveState } from "./commands/terminal";
import { terminateAllSessions } from "./features/work-bench/window-cleanup";
import "./styles/globals.css";

// Restore the saved view before the first paint so the app opens on the last Space
// instead of flashing the Dashboard. A failed restore falls back to defaults.
async function bootstrap() {
  const store = getDefaultStore();
  store.set(queryClientAtom, queryClient);
  initQuerySync();
  initPrSync();
  try {
    const win = getCurrentWebviewWindow();
    const windowLabel = win.label;
    store.set(windowLabelAtom, windowLabel);
    await hydrateUiState({ windowLabel });
    initUiStatePersistence({ windowLabel });

    if (windowLabel === MAIN_WINDOW_LABEL) {
      const secondaryLabels = await getSecondaryWindowLabels();
      for (const label of secondaryLabels) {
        try {
          await unwrap(commands.openNamedWindow(label));
        } catch (e) {
          console.warn(`failed to restore window ${label}:`, e);
        }
      }
    } else {
      await ensureWindowEntry(windowLabel);
      const unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        await terminateAllSessions(store.get(terminalStateAtom));
        await terminalSaveState(windowLabel, { runspaces: [] });
        await removeWindowEntry(windowLabel);
        unlisten();
        await win.destroy();
      });
    }
  } finally {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

void bootstrap();
