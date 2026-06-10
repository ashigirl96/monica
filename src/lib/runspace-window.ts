import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

declare global {
  interface Window {
    __MONICA_RUNSPACE_CWD__?: string;
  }
}

export function isRunspaceWindow(): boolean {
  return getCurrentWebviewWindow().label.startsWith("runspace-");
}

export function runspaceWindowCwd(): string {
  return window.__MONICA_RUNSPACE_CWD__ ?? "~";
}
