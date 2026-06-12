import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { hydrateUiState } from "./stores/ui-state";
import { initUiStatePersistence } from "./stores/ui-state-persistence";
import "./styles/globals.css";

// Restore the saved view before the first paint so the app opens on the last Space
// instead of flashing the Dashboard. A failed restore falls back to defaults.
async function bootstrap() {
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
