import type { ListItem } from "../contract.ts";

// task.list は track した順に返すので、新しい順にするには逆にする。
export function attachChoices(tasks: ListItem[], agentSessionId: string | null): ListItem[] | null {
  const isRun = tasks.some(
    ({ displayState }) =>
      "liveRuns" in displayState &&
      displayState.liveRuns.some((r) => r.agentSessionId === agentSessionId),
  );
  return isRun ? null : tasks.toReversed();
}
