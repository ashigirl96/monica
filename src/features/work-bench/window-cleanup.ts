import { detachTab, type TerminalState } from "@/features/work-bench/store";

export async function detachAllSessions(state: TerminalState | null): Promise<void> {
  if (!state) return;
  await Promise.allSettled(state.runspaces.flatMap((rs) => rs.tabs.map((tab) => detachTab(tab))));
}
