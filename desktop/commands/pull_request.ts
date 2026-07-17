import { commands, events, type PrSyncCompleted } from "./bindings";
import { unwrap } from "./unwrap";

export async function forceSyncPullRequests(): Promise<void> {
  await unwrap(commands.forceSyncPullRequests());
}

export function onPrSyncCompleted(cb: (payload: PrSyncCompleted) => void) {
  return events.prSyncCompleted.listen((e) => cb(e.payload));
}
