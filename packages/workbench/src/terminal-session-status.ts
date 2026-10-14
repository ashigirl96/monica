import { type AnyColumn, and, eq, exists, inArray, notExists, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { TerminalSession } from './contract.ts'
import type { Db } from './db.ts'
import { tab, terminalSession } from './schema.ts'

export const LIVE = ['starting', 'running'] as const

export function isLive(status: TerminalSession['status']): boolean {
  return (LIVE as readonly string[]).includes(status)
}

// 呼び手の query が同じ table を from に持っても相関が自分に閉じないよう、別名で引く。
const hostSession = alias(terminalSession, 'terminating_terminal_session')
const shownTab = alias(tab, 'terminating_tab')

// Tab を閉じると Terminate を予約するので、Exit の記録を待たずに終わったものと読む（ADR-0023）。
export function terminating(
  reader: Pick<Db, 'select'>,
  terminalSessionId: AnyColumn | string,
): SQL {
  const live = exists(
    reader
      .select({ id: hostSession.id })
      .from(hostSession)
      .where(and(eq(hostSession.id, terminalSessionId), inArray(hostSession.status, LIVE))),
  )
  const tabless = notExists(
    reader
      .select({ id: shownTab.id })
      .from(shownTab)
      .where(eq(shownTab.terminalSessionId, terminalSessionId)),
  )
  return sql`(${live} and ${tabless})`
}
