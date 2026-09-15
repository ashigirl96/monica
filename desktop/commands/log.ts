import { invoke } from "@tauri-apps/api/core";

// tauri-plugin-log's `LogLevel` is a `Deserialize_repr(u16)`, so the wire value is the ordinal.
const LEVEL = { warn: 4, error: 5 } as const;

export type BackendLogLevel = keyof typeof LEVEL;

/// Hand a frontend line to the Rust logger, which in a release build is the only writer of
/// `~/monica/logs/monica.log`.
///
/// `location` is deliberately not sent. The plugin appends it to the log target (`webview:<loc>`),
/// and fern matches targets by `::`-separated segment rather than by prefix, so a located target
/// could no longer be turned down with `MONICA_LOG=webview=off`. The call site puts the origin in
/// the message instead.
export function logToBackend(level: BackendLogLevel, message: string): Promise<void> {
  return invoke("plugin:log|log", { level: LEVEL[level], message });
}
