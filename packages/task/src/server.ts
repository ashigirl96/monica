import type { Db } from '@monica/workbench/server'
import { implement } from '@orpc/server'

import { attachTab } from './attach.ts'
import { listBenches } from './bench.ts'
import { closeTask, reopenTask } from './close.ts'
import { contract } from './contract.ts'
import { currentTask } from './current.ts'
import { listTasks } from './list.ts'
import { runButtons, runFromButton } from './run-button.ts'
import { runTask } from './run-claude.ts'
import { syncCommand, trackIssue } from './sync.ts'
import { internals, type TaskLedger } from './task.ts'

export { migrations } from '../migrations/index.ts'
export { nameAgentSession } from './current.ts'
export type { GitHub } from './github.ts'
export type { Ghq } from './prepare.ts'
export { createTaskLedger, systemJobs, type TaskLedger } from './task.ts'

const os = implement(contract).$context<{ db: Db; taskLedger: TaskLedger }>()

export const router = os.router({
  track: os.track.handler(({ context, input }) =>
    trackIssue(internals(context.taskLedger), input.ref),
  ),
  sync: os.sync.handler(({ context, input }) =>
    syncCommand(internals(context.taskLedger), input.ref),
  ),
  list: os.list.handler(({ context, input }) => ({
    tasks: listTasks(context.db, { closed: input.closed ?? false }),
    backgroundSyncError: internals(context.taskLedger).backgroundSyncError(),
  })),
  run: os.run.handler(({ context, input, errors }) =>
    runTask(internals(context.taskLedger), input, errors),
  ),
  runButtons: os.runButtons.handler(({ context, input }) =>
    runButtons(internals(context.taskLedger), input.refs),
  ),
  runFromButton: os.runFromButton.handler(({ context, input, errors }) =>
    runFromButton(internals(context.taskLedger), input.ref, errors),
  ),
  current: os.current.handler(({ context, input }) =>
    currentTask(context.db, input.terminalSessionId),
  ),
  attach: os.attach.handler(({ context, input }) =>
    attachTab(internals(context.taskLedger), input),
  ),
  close: os.close.handler(({ context, input, errors }) =>
    closeTask(internals(context.taskLedger), input, errors),
  ),
  reopen: os.reopen.handler(({ context, input }) =>
    reopenTask(internals(context.taskLedger), input),
  ),
  bench: {
    list: os.bench.list.handler(({ context }) => listBenches(context.db)),
  },
  changes: os.changes.handler(async function* ({ context, signal }) {
    for await (const change of context.taskLedger.events.subscribe('change', { signal })) {
      yield change
    }
  }),
})
