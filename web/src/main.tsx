import "@fontsource-variable/jetbrains-mono/index.css";
import { initAmbient } from "./ambient";
import { initNoteWidth } from "./note-width";
import { initTheme } from "./theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { AutosaveProvider } from "./notes/autosave-context";
import { queryClient } from "./query";
import "./globals.css";

initTheme();
initAmbient();
initNoteWidth();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AutosaveProvider>
        <App />
      </AutosaveProvider>
    </QueryClientProvider>
  </StrictMode>,
);
