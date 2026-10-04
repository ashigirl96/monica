import { table } from "@tania/ui/table";
import type {
  AttachOutput,
  CloseOutput,
  CurrentOutput,
  ListItem,
  ListOutput,
  ReopenOutput,
  RunOutput,
  SyncOutput,
  TrackOutput,
} from "./contract.ts";
import { stateText } from "./state-text.ts";

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
      ...warningLines(warnings),
    ].join("\n");
  },
  attach({ ref, title, benchCreated, runCreated, agentSessionId }: AttachOutput): string {
    return [
      ...(benchCreated ? [`opened the Bench of ${ref} in place`] : []),
      `this Tab is in the Bench of ${ref} ${title}`,
      agentSessionId === null
        ? `no claude runs in this Tab; the one you start here becomes a Run of ${ref}`
        : `claude ${agentSessionId} ${runCreated ? "is now" : "is"} a Run of ${ref}`,
    ].join("\n");
  },
  close({ ref, removedWorktree, deletedBranch, spared, warnings }: CloseOutput): string {
    return [
      `closed ${ref}`,
      ...(removedWorktree ? [`removed the worktree ${removedWorktree}`] : []),
      ...(deletedBranch ? [`deleted the branch ${deletedBranch}`] : []),
      ...(spared ? ["this Tab stays, in a Runspace that is no longer a Bench"] : []),
      ...warningLines(warnings),
    ].join("\n");
  },
  reopen({ ref, title, warnings }: ReopenOutput): string {
    return [`reopened ${ref} ${title}`, ...warningLines(warnings)].join("\n");
  },
  current({ ref, title, displayState }: CurrentOutput): string {
    return table([
      ["REF", "TITLE", "STATE"],
      [ref, title, stateText(displayState)],
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
                stateText(t.displayState),
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

function warningLines(warnings: string[]): string[] {
  return warnings.map((warning) => `warning: ${warning}`);
}
