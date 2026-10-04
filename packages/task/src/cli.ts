import { table } from "@tania/ui/table";
import type {
  CurrentOutput,
  DisplayState,
  ListItem,
  ListOutput,
  RunOutput,
  SyncOutput,
  TrackOutput,
} from "./contract.ts";

export const commands = [] as const;

export const formatters = {
  track({ ref, title, alreadyTracked, closed }: TrackOutput): string {
    if (!alreadyTracked) return `tracked ${ref} ${title}`;
    if (closed) return `already tracked ${ref}; it is closed, so run \`tania task reopen ${ref}\``;
    return `already tracked ${ref}`;
  },
  sync({ synced, missing }: SyncOutput): string {
    const lines = [`synced ${synced} ${synced === 1 ? "Task" : "Tasks"}`];
    if (missing.length > 0) {
      lines.push(`GitHub did not return ${missing.join(", ")}; their copies are kept`);
    }
    return lines.join("\n");
  },
  run({ ref, cwd, benchCreated, resumed, warnings }: RunOutput): string {
    return [
      benchCreated ? `opened the Bench of ${ref} at ${cwd}` : `the Bench of ${ref} is at ${cwd}`,
      resumed ? `resumed claude ${resumed} in a new Tab` : "started claude in a new Tab",
      ...warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
  },
  current({ ref, title, displayState }: CurrentOutput): string {
    return table([
      ["REF", "TITLE", "STATE"],
      [ref, title, stateCell(displayState)],
    ]);
  },
  list({ tasks, backgroundSyncError }: ListOutput): string {
    const lines =
      tasks.length === 0
        ? ["No Tasks"]
        : [
            table([
              ["REF", "TITLE", "STATE", "BLOCKED BY", "CWD"],
              ...tasks.map((t) => [
                t.ref,
                t.title,
                stateCell(t.displayState),
                blockedBy(t) || "-",
                t.cwd ?? "-",
              ]),
            ]),
          ];
    if (backgroundSyncError) {
      const { at, message } = backgroundSyncError;
      lines.push(`warning: the background sync failed at ${at.toISOString()}: ${message}`);
    }
    return lines.join("\n");
  },
};

function stateCell(displayState: DisplayState): string {
  if (!("liveRuns" in displayState)) return displayState.state;
  const head =
    displayState.state === "waiting"
      ? `waiting:${displayState.reason}${displayState.tool ? `(${displayState.tool})` : ""}`
      : displayState.state;
  const others = displayState.liveRuns.length - 1;
  return `${head} ${age(displayState.since)}${others > 0 ? ` +${others}` : ""}`;
}

function age(since: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function blockedBy({ ref, blockers }: ListItem): string {
  const repo = repoOf(ref).toLowerCase();
  return blockers
    .map((blocker) =>
      repoOf(blocker).toLowerCase() === repo ? blocker.slice(blocker.indexOf("#")) : blocker,
    )
    .join(", ");
}

function repoOf(ref: string): string {
  return ref.slice(0, ref.indexOf("#"));
}
