import { eq, getTableColumns, inArray, isNotNull, or } from 'drizzle-orm'

import type { Db } from './db.ts'
import { tab, terminalSession } from './schema.ts'
import { LIVE } from './terminal-session-status.ts'

export function listTerminalSessions(db: Db) {
  return db
    .select({ ...getTableColumns(terminalSession), tabId: tab.id })
    .from(terminalSession)
    .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
    .where(or(inArray(terminalSession.status, LIVE), isNotNull(tab.id)))
    .orderBy(terminalSession.createdAt)
    .all()
}
