import { commands, events, type PrSyncCompleted } from "./bindings";

export function forceSyncPullRequests(): Promise<void> {
  return commands.forceSyncPullRequests().then((r) => {
    if (r.status === "error") throw new Error(r.error);
  });
}

export function onPrSyncCompleted(cb: (payload: PrSyncCompleted) => void) {
  return events.prSyncCompleted.listen((e) => cb(e.payload));
}
