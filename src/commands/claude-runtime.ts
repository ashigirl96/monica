import { commands, events, type ClaudeSession, type ClaudeSessionOpened } from "./bindings";
import { unwrap } from "./unwrap";

export function onClaudeSessionOpened(cb: (payload: ClaudeSessionOpened) => void) {
  return events.claudeSessionOpened.listen((e) => cb(e.payload));
}

export function claudeListSessions(): Promise<ClaudeSession[]> {
  return unwrap(commands.claudeListSessions());
}
