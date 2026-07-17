import { terminateTab, type TerminalState } from "@/features/work-bench/store";

export async function terminateAllSessions(state: TerminalState | null): Promise<void> {
  if (!state) return;
  await Promise.allSettled(
    state.runspaces.flatMap((rs) => rs.tabs.map((tab) => terminateTab(tab))),
  );
}
