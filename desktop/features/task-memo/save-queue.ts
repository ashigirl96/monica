// Per-task write queue shared across editor mounts. Serializing here (not per mount)
// closes the reopen race: close flushes a write, an immediate reopen must not read the
// DB before that write lands, and the new mount's saves must queue behind it.
const tails = new Map<string, Promise<void>>();

export function enqueueTaskMemoWrite(taskId: string, write: () => Promise<void>): Promise<void> {
  const tail = (tails.get(taskId) ?? Promise.resolve()).then(write).catch(() => {});
  tails.set(taskId, tail);
  return tail;
}

export function pendingTaskMemoWrites(taskId: string): Promise<void> {
  return tails.get(taskId) ?? Promise.resolve();
}
