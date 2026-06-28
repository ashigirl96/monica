import type { TerminalState } from "@/features/work-bench/store";
import { releaseTabConnection } from "@/features/work-bench/terminal-connections";
import { terminalDetach } from "@/commands/terminal";

export async function detachAllSessions(state: TerminalState | null): Promise<void> {
  if (!state) return;
  const detachPromises: Promise<void>[] = [];
  for (const rs of state.runspaces) {
    for (const tab of rs.tabs) {
      const sessionId = releaseTabConnection(tab.id) ?? tab.sessionId;
      if (sessionId) {
        detachPromises.push(terminalDetach(sessionId).catch(() => {}));
      }
    }
  }
  await Promise.allSettled(detachPromises);
}
