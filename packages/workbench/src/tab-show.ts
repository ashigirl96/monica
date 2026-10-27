import { ORPCError } from '@orpc/server'
import { asc, eq } from 'drizzle-orm'

import type { ShownRunspace, ShownTab } from './contract.ts'
import type { Db } from './db.ts'
import { asTab } from './layout.ts'
import { runspace, tab, terminalSession } from './schema.ts'
import { processesOf, type WorkbenchLedger } from './workbench.ts'

/** Tab 1 つ分の show の中身。 */
export async function showTab(
  db: Db,
  workbenchLedger: WorkbenchLedger,
  tabId: string,
): Promise<ShownTab> {
  const found = db
    .select({ tab, terminalSession })
    .from(tab)
    .innerJoin(terminalSession, eq(terminalSession.id, tab.terminalSessionId))
    .where(eq(tab.id, tabId))
    .get()
  if (!found) throw new ORPCError('NOT_FOUND', { message: `no Tab ${tabId}` })
  const processes = await processesOf(workbenchLedger)(found.terminalSession.id)
  return {
    tab: asTab(found.tab),
    terminalSession: found.terminalSession,
    processes:
      processes?.map(({ terminal_session_process, ...rest }) => ({
        ...rest,
        terminalSessionProcess: terminal_session_process,
      })) ?? null,
  }
}

/** Runspace と、その Tab ごとの show の中身を Tab の並び順に。 */
export async function showRunspace(
  db: Db,
  workbenchLedger: WorkbenchLedger,
  runspaceId: string,
): Promise<ShownRunspace> {
  const found = db.select().from(runspace).where(eq(runspace.id, runspaceId)).get()
  if (!found) throw new ORPCError('NOT_FOUND', { message: `no Runspace ${runspaceId}` })
  const tabIds = db
    .select({ id: tab.id })
    .from(tab)
    .where(eq(tab.runspaceId, runspaceId))
    .orderBy(asc(tab.sortOrder))
    .all()
  // showTab は最初の await の前に行を読むので、どの Tab も ptyd を待つ間の close に当たらない。
  const tabs = await Promise.all(tabIds.map(({ id }) => showTab(db, workbenchLedger, id)))
  return { runspace: found, tabs }
}
