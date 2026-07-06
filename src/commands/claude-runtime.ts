import {
  commands,
  events,
  type ClaudeSession,
  type ClaudeSessionMessage,
  type ClaudeSessionOpened,
  type ClaudeSessionStateChanged,
  type ClaudeTranscriptRecord,
} from "./bindings";
import { unwrap } from "./unwrap";

export function onClaudeSessionOpened(cb: (payload: ClaudeSessionOpened) => void) {
  return events.claudeSessionOpened.listen((e) => cb(e.payload));
}

export function onClaudeSessionStateChanged(cb: (payload: ClaudeSessionStateChanged) => void) {
  return events.claudeSessionStateChanged.listen((e) => cb(e.payload));
}

export function onClaudeSessionMessage(cb: (payload: ClaudeSessionMessage) => void) {
  return events.claudeSessionMessage.listen((e) => cb(e.payload));
}

export function claudeListSessions(): Promise<ClaudeSession[]> {
  return unwrap(commands.claudeListSessions());
}

export function claudeSessionTranscript(
  claudeSessionId: string,
): Promise<ClaudeTranscriptRecord[]> {
  return unwrap(commands.claudeSessionTranscript(claudeSessionId));
}
