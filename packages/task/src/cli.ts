import { table } from "@tania/ui/table";
import type { ListItem, ListOutput, SyncOutput, TrackOutput } from "./contract.ts";

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
                t.displayState.state,
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
