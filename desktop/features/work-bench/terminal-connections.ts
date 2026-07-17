import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";

// Module-level so StrictMode's double effects and active-toggle remounts share one
// connection per tab (same role the old aliveSessions set played for spawns).
export type TabConnection = {
  state: "connecting" | "attached" | "dead";
  sessionId?: string;
  inFlight?: Promise<void>;
  unlisteners: UnlistenFn[];
  // While the attach replay is being parsed, xterm answers terminal queries recorded in
  // the transcript (DA, OSC 10/11, kitty); those responses must not reach the live PTY.
  replaying?: boolean;
};

const tabConnections = new Map<string, TabConnection>();

export function getTabConnection(tabId: string): TabConnection | undefined {
  return tabConnections.get(tabId);
}

export function openTabConnection(tabId: string): TabConnection {
  const conn: TabConnection = { state: "connecting", unlisteners: [] };
  tabConnections.set(tabId, conn);
  return conn;
}

// tab → the Terminal currently mounted for it. Session listeners and the in-flight
// connect outlive a React mount (StrictMode double-mounts, active toggles), so writes
// must resolve the *current* instance instead of closing over one that may have been
// disposed — xterm throws renderer TypeErrors when written to after dispose.
const tabTerminals = new Map<string, Terminal>();

export function setTabTerminal(tabId: string, term: Terminal) {
  tabTerminals.set(tabId, term);
}

export function clearTabTerminal(tabId: string, term: Terminal) {
  if (tabTerminals.get(tabId) === term) tabTerminals.delete(tabId);
}

export function getTabTerminal(tabId: string): Terminal | undefined {
  return tabTerminals.get(tabId);
}

/// Drop the registry entry and its event listeners; returns the session that was bound so
/// the caller can detach it.
export function releaseTabConnection(tabId: string): string | undefined {
  const conn = tabConnections.get(tabId);
  if (!conn) return undefined;
  tabConnections.delete(tabId);
  for (const unlisten of conn.unlisteners) unlisten();
  // The connect error path also unlistens whatever is left; clearing here keeps a
  // release racing that path from double-invoking the same UnlistenFns.
  conn.unlisteners = [];
  return conn.sessionId;
}
