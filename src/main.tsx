import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getDefaultStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { initPrSync } from "./stores/pr-sync";
import { queryClient } from "./stores/query-client";
import { initQuerySync } from "./stores/query-sync";
import { hydrateUiState, windowLabelAtom, MAIN_WINDOW_LABEL } from "./stores/ui-state";
import { initUiStatePersistence } from "./stores/ui-state-persistence";
import { terminalStateAtom } from "./features/work-bench/store";
import { detachAllSessions } from "./features/work-bench/window-cleanup";
import "./styles/globals.css";

// Restore the saved view before the first paint so the app opens on the last Space
// instead of flashing the Dashboard. A failed restore falls back to defaults.
async function bootstrap() {
  const store = getDefaultStore();
  store.set(queryClientAtom, queryClient);
  initQuerySync();
  initPrSync();
  try {
    const windowLabel = getCurrentWebviewWindow().label;
    store.set(windowLabelAtom, windowLabel);
    await hydrateUiState({ windowLabel });
    initUiStatePersistence({ windowLabel });

    if (windowLabel !== MAIN_WINDOW_LABEL) {
      const win = getCurrentWebviewWindow();
      win.onCloseRequested(async (event) => {
        event.preventDefault();
        await detachAllSessions(store.get(terminalStateAtom));
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
