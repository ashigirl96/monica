import { homedir } from 'node:os'

import { implement } from '@orpc/server'
import { eq, getTableColumns, inArray, isNotNull, or } from 'drizzle-orm'

import { listAgentSessions, markSeenIfUnread, recordHook } from './agent-session.ts'
import { contract } from './contract.ts'
import { openInEditor, resolveEditorPaths } from './editor.ts'
import {
  asTab,
  closeTab,
  createRunspace,
  moveRunspace,
  moveTab,
  openTab,
  pinTab,
  readLayout,
  refuseRemoving,
  removeRunspace,
  respawnTab,
  setTabCwd,
  unpinTab,
  writeLayout,
} from './layout.ts'
import { repoOf } from './repo.ts'
import { tab, terminalSession } from './schema.ts'
import { LIVE } from './terminal-session.ts'
import { terminalSessionsOf, type WorkbenchContext } from './workbench.ts'

export { migrations } from '../migrations/index.ts'
export { inheritableEnv } from './ptyd.ts'
export { createWorkbenchLedger, type Db, type Tx, type WorkbenchLedger } from './workbench.ts'

const os = implement(contract).$context<WorkbenchContext>()

export const router = os.router({
  terminalSession: {
    list: os.terminalSession.list.handler(({ context }) =>
      context.db
        .select({ ...getTableColumns(terminalSession), tabId: tab.id })
        .from(terminalSession)
        .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
        .where(or(inArray(terminalSession.status, LIVE), isNotNull(tab.id)))
        .orderBy(terminalSession.createdAt)
        .all(),
    ),
  },
  layout: {
    get: os.layout.get.handler(({ context }) => readLayout(context.db)),
  },
  runspace: {
    create: os.runspace.create.handler(({ context, input }) => {
      const cwd = input.cwd ?? homedir()
      const opened = writeLayout(context, (tx) =>
        openTab(tx, terminalSessionsOf(context.workbenchLedger), {
          runspaceId: createRunspace(tx, { cwd, index: input.index }),
          cwd,
          size: { rows: input.rows, cols: input.cols },
        }),
      )
      return { runspaceId: opened.runspaceId, tab: asTab(opened) }
    }),
    remove: os.runspace.remove.handler(({ context, input }) => {
      writeLayout(context, (tx) => {
        refuseRemoving(tx, input.id)
        removeRunspace(tx, terminalSessionsOf(context.workbenchLedger), input.id)
      })
    }),
    move: os.runspace.move.handler(({ context, input }) => {
      writeLayout(context, (tx) => moveRunspace(tx, input))
    }),
  },
  tab: {
    open: os.tab.open.handler(({ context, input }) => {
      const { runspaceId, cwd, index, rows, cols } = input
      return asTab(
        writeLayout(context, (tx) =>
          openTab(tx, terminalSessionsOf(context.workbenchLedger), {
            runspaceId,
            cwd,
            index,
            size: { rows, cols },
          }),
        ),
      )
    }),
    respawn: os.tab.respawn.handler(({ context, input }) =>
      asTab(
        respawnTab(context, terminalSessionsOf(context.workbenchLedger), input.id, {
          rows: input.rows,
          cols: input.cols,
        }),
      ),
    ),
    close: os.tab.close.handler(({ context, input }) =>
      writeLayout(context, (tx) =>
        closeTab(tx, terminalSessionsOf(context.workbenchLedger), input.id),
      ),
    ),
    move: os.tab.move.handler(({ context, input }) => {
      writeLayout(context, (tx) => moveTab(tx, input))
    }),
    setCwd: os.tab.setCwd.handler(({ context, input }) => {
      writeLayout(context, (tx) => setTabCwd(tx, input))
    }),
    pin: os.tab.pin.handler(({ context, input }) => {
      writeLayout(context, (tx) => pinTab(tx, input.id))
    }),
    unpin: os.tab.unpin.handler(({ context, input }) => {
      writeLayout(context, (tx) => unpinTab(tx, input.id))
    }),
  },
  agentSession: {
    recordHook: os.agentSession.recordHook.handler(({ context, input }) => {
      for (const sessionId of recordHook(context, input)) {
        context.workbenchLedger.events.publish('change', { type: 'agentSession', sessionId })
      }
    }),
    list: os.agentSession.list.handler(({ context }) => listAgentSessions(context.db)),
    markSeen: os.agentSession.markSeen.handler(({ context, input }) => {
      if (markSeenIfUnread(context.db, input)) {
        context.workbenchLedger.events.publish('change', {
          type: 'agentSession',
          sessionId: input.sessionId,
        })
      }
    }),
  },
  repo: {
    of: os.repo.of.handler(({ input }) => repoOf(input.cwd)),
  },
  editor: {
    resolve: os.editor.resolve.handler(({ input }) =>
      resolveEditorPaths(input.cwd, input.candidates),
    ),
    open: os.editor.open.handler(({ input }) => openInEditor(input.path)),
  },
  changes: os.changes.handler(async function* ({ context, signal }) {
    for await (const change of context.workbenchLedger.events.subscribe('change', { signal })) {
      yield change
    }
  }),
})
