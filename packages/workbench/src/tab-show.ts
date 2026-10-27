import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'

import type { ShownTab } from './contract.ts'
import type { Db } from './db.ts'
import { asTab } from './layout.ts'
import { tab, terminalSession } from './schema.ts'
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
