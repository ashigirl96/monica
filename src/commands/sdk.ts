import { commands, events, type ClaudeSession, type SdkSessionOpened } from "./bindings";
import { unwrap } from "./unwrap";

export function onSdkSessionOpened(cb: (payload: SdkSessionOpened) => void) {
  return events.sdkSessionOpened.listen((e) => cb(e.payload));
}

export function claudeListSessions(): Promise<ClaudeSession[]> {
  return unwrap(commands.claudeListSessions());
}
