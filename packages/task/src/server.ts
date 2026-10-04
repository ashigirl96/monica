import { implement } from "@orpc/server";
import type { Db } from "@tania/workbench/server";
import { attachTab } from "./attach.ts";
import { listBenches } from "./bench.ts";
import { contract } from "./contract.ts";
import { currentTask } from "./current.ts";
import { listTasks } from "./list.ts";
import { runTask } from "./run-claude.ts";
import { syncCommand, trackIssue } from "./sync.ts";
import { internals, type Task } from "./task.ts";

export { migrations } from "../migrations/index.ts";
export { nameAgentSession } from "./current.ts";
export type { GitHub } from "./github.ts";
export type { Ghq } from "./prepare.ts";
export { createTask, type Task } from "./task.ts";

const os = implement(contract).$context<{ db: Db; task: Task }>();

export const router = os.router({
  track: os.track.handler(({ context, input }) => trackIssue(internals(context.task), input.ref)),
  sync: os.sync.handler(({ context, input }) => syncCommand(internals(context.task), input.ref)),
  list: os.list.handler(({ context, input }) => ({
    tasks: listTasks(context.db, { closed: input.closed ?? false }),
    backgroundSyncError: internals(context.task).backgroundSyncError(),
  })),
  run: os.run.handler(({ context, input, errors }) =>
    runTask(internals(context.task), input, errors),
  ),
  current: os.current.handler(({ context, input }) =>
    currentTask(context.db, input.terminalSessionId),
  ),
  attach: os.attach.handler(({ context, input }) => attachTab(internals(context.task), input)),
  bench: {
    list: os.bench.list.handler(({ context }) => listBenches(context.db)),
  },
  changes: os.changes.handler(async function* ({ context, signal }) {
    for await (const change of context.task.events.subscribe("change", { signal })) {
      yield change;
    }
  }),
});
