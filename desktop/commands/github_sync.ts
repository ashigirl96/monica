import { commands, events, type GithubSyncCompleted } from "./bindings";
import { unwrap } from "./unwrap";

export async function forceSyncGithub(): Promise<void> {
  await unwrap(commands.forceSyncGithub());
}

export function onGithubSyncCompleted(cb: (payload: GithubSyncCompleted) => void) {
  return events.githubSyncCompleted.listen((e) => cb(e.payload));
}
