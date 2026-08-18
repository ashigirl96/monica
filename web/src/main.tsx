import "@fontsource-variable/jetbrains-mono/index.css";
import { initAmbient } from "./ambient";
import { initNoteWidth } from "./note-width";
import { initTheme } from "./theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./globals.css";

initTheme();
initAmbient();
initNoteWidth();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
