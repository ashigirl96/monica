import { homedir } from 'node:os'

import { implement } from '@orpc/server'
import { eq, getTableColumns, inArray, isNotNull, or } from 'drizzle-orm'

import { listAgentSessions } from './agent-session.ts'
import { contract } from './contract.ts'
import { openInEditor, resolveEditorPaths } from './editor.ts'
import { asTab, readLayout } from './layout.ts'
import { repoOf } from './repo.ts'
import { tab, terminalSession } from './schema.ts'
import { LIVE } from './terminal-session.ts'
import { agentSessionsOf, layoutWritesOf, type WorkbenchContext } from './workbench.ts'

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
    create: os.runspace.create.handler(({ context: { db, workbenchLedger }, input }) => {
      const { index, rows, cols } = input
      const opened = db.transaction((tx) =>
        layoutWritesOf(workbenchLedger).openRunspace(tx, {
          cwd: input.cwd ?? homedir(),
          index,
          size: { rows, cols },
        }),
      )
      return { runspaceId: opened.runspaceId, tab: asTab(opened) }
    }),
    remove: os.runspace.remove.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).removeRunspace(tx, input.id))
    }),
    move: os.runspace.move.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).moveRunspace(tx, input))
    }),
  },
  tab: {
    open: os.tab.open.handler(({ context: { db, workbenchLedger }, input }) => {
      const { runspaceId, cwd, index, rows, cols } = input
      return asTab(
        db.transaction((tx) =>
          layoutWritesOf(workbenchLedger).openTab(tx, {
            runspaceId,
            cwd,
            index,
            size: { rows, cols },
          }),
        ),
      )
    }),
    respawn: os.tab.respawn.handler(({ context: { db, workbenchLedger }, input }) => {
      const { id, rows, cols } = input
      return asTab(
        db.transaction((tx) => layoutWritesOf(workbenchLedger).respawnTab(tx, id, { rows, cols })),
      )
    }),
    close: os.tab.close.handler(({ context: { db, workbenchLedger }, input }) =>
      db.transaction((tx) => layoutWritesOf(workbenchLedger).closeTab(tx, input.id)),
    ),
    move: os.tab.move.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).moveTab(tx, input))
    }),
    setCwd: os.tab.setCwd.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).setTabCwd(tx, input))
    }),
    pin: os.tab.pin.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).pinTab(tx, input.id))
    }),
    unpin: os.tab.unpin.handler(({ context: { db, workbenchLedger }, input }) => {
      db.transaction((tx) => layoutWritesOf(workbenchLedger).unpinTab(tx, input.id))
    }),
  },
  agentSession: {
    recordHook: os.agentSession.recordHook.handler(({ context, input }) =>
      agentSessionsOf(context.workbenchLedger).recordHook(input),
    ),
    list: os.agentSession.list.handler(({ context }) => listAgentSessions(context.db)),
    markSeen: os.agentSession.markSeen.handler(({ context, input }) =>
      agentSessionsOf(context.workbenchLedger).markSeen(input),
    ),
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
