import { homedir } from 'node:os'

import { implement } from '@orpc/server'

import { listAgentSessions } from './agent-session.ts'
import { idOrCaller } from './caller.ts'
import { contract } from './contract.ts'
import { openInEditor, resolveEditorPaths } from './editor.ts'
import { asTab, readLayout } from './layout.ts'
import { listTerminalSessions } from './reads.ts'
import { repoOf } from './repo.ts'
import { showRunspace, showTab } from './tab-show.ts'
import {
  agentSessionsOf,
  layoutWritesOf,
  remoteAccessOf,
  type WorkbenchContext,
} from './workbench.ts'

export { migrations } from '../migrations/index.ts'
export { inheritableEnv } from './ptyd.ts'
export { LIVE, terminating } from './terminal-session-status.ts'
export type { Db, Tx } from './db.ts'
export { createWorkbenchLedger, type WorkbenchLedger } from './workbench.ts'

const os = implement(contract).$context<WorkbenchContext>()

export const router = os.router({
  remote: {
    status: os.remote.status.handler(({ context }) =>
      remoteAccessOf(context.workbenchLedger).status(),
    ),
    enable: os.remote.enable.handler(({ context, input }) =>
      remoteAccessOf(context.workbenchLedger).enable(input),
    ),
    disable: os.remote.disable.handler(({ context }) =>
      remoteAccessOf(context.workbenchLedger).disable(),
    ),
    invite: os.remote.invite.handler(({ context }) =>
      remoteAccessOf(context.workbenchLedger).invite(),
    ),
    approve: os.remote.approve.handler(({ context, input }) =>
      remoteAccessOf(context.workbenchLedger).approve(input.id),
    ),
    reject: os.remote.reject.handler(({ context, input }) =>
      remoteAccessOf(context.workbenchLedger).reject(input.id),
    ),
    revoke: os.remote.revoke.handler(({ context, input }) =>
      remoteAccessOf(context.workbenchLedger).revoke(input.id),
    ),
    renewIdentity: os.remote.renewIdentity.handler(({ context }) =>
      remoteAccessOf(context.workbenchLedger).renewIdentity(),
    ),
  },
  terminalSession: {
    list: os.terminalSession.list.handler(({ context }) => listTerminalSessions(context.db)),
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
    remove: os.runspace.remove.handler(({ context: { db, workbenchLedger }, input }) =>
      db.transaction((tx) => {
        const runspaceId = idOrCaller(tx, input, 'Runspace')
        layoutWritesOf(workbenchLedger).removeRunspace(tx, runspaceId)
        return { runspaceId }
      }),
    ),
    show: os.runspace.show.handler(({ context: { db, workbenchLedger }, input }) => {
      const runspaceId = db.transaction((tx) => idOrCaller(tx, input, 'Runspace'))
      return showRunspace(db, workbenchLedger, runspaceId)
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
      db.transaction((tx) => {
        const tabId = idOrCaller(tx, input, 'Tab')
        return { tabId, ...layoutWritesOf(workbenchLedger).closeTab(tx, tabId) }
      }),
    ),
    show: os.tab.show.handler(({ context: { db, workbenchLedger }, input }) => {
      const tabId = db.transaction((tx) => idOrCaller(tx, input, 'Tab'))
      return showTab(db, workbenchLedger, tabId)
    }),
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
