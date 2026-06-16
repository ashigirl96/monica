import { getDefaultStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { queryClient } from "./stores/query-client";
import { hydrateUiState } from "./stores/ui-state";
import { initUiStatePersistence } from "./stores/ui-state-persistence";
import "./styles/globals.css";

// Restore the saved view before the first paint so the app opens on the last Space
// instead of flashing the Dashboard. A failed restore falls back to defaults.
async function bootstrap() {
  // Inject the singleton client into the default store so every atomWithQuery shares
  // it without a <Provider>, matching how hydrateUiState seeds the same store.
  getDefaultStore().set(queryClientAtom, queryClient);
  try {
    await hydrateUiState();
    initUiStatePersistence();
  } finally {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

void bootstrap();
