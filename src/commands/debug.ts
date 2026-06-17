import { commands } from "./bindings";

// Fire-and-forget trace into ~/monica/logs/monica.log (issue #157). The release webview has no
// devtools, so console.log is invisible there; this routes through Rust's tauri-plugin-log sink.
export function debugLog(message: string): void {
  void commands.debugLog(message);
}
