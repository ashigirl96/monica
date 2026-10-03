import "@fontsource-variable/jetbrains-mono";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BackendProvider } from "./backend-provider.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-screen w-screen flex-col">
      <BackendProvider>
        <App />
      </BackendProvider>
    </div>
  </StrictMode>,
);
