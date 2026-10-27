import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'

import type { Tx } from './db.ts'
import { tab } from './schema.ts'

/** id を省いた CLI の呼び出しが指す、呼んだ Terminal Session の Tab。 */
export function callerTab(tx: Tx, terminalSessionId: string | undefined) {
  if (!terminalSessionId) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'not in a Tab of the Workbench: give an id, or run this in a Tab',
    })
  }
  const found = tx
    .select({ id: tab.id, runspaceId: tab.runspaceId })
    .from(tab)
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()
  if (!found) {
    throw new ORPCError('BAD_REQUEST', {
      message: `not in a Tab of the Workbench: Terminal Session ${terminalSessionId} is in no Tab`,
    })
  }
  return found
}
