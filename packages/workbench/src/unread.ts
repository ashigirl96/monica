import type { EventPublisher } from '@orpc/server'
import { ne } from 'drizzle-orm'

import type { AgentSession, WorkbenchChange } from './contract.ts'
import type { Db } from './db.ts'
import { agentSession } from './schema.ts'

export function isUnread(row: Pick<AgentSession, 'notifiedAt' | 'seenAt'>): boolean {
  return row.notifiedAt !== null && row.seenAt === null
}

function unreadTerminalSessions(db: Db): string[] {
  // 終わった行は未読でなく、消さずに溜まるので読まない。
  return db
    .select({
      terminalSessionId: agentSession.terminalSessionId,
      notifiedAt: agentSession.notifiedAt,
      seenAt: agentSession.seenAt,
    })
    .from(agentSession)
    .where(ne(agentSession.state, 'ended'))
    .orderBy(agentSession.terminalSessionId)
    .all()
    .filter(isUnread)
    .map((row) => row.terminalSessionId)
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** followUnread を呼んだ時に 1 回、以降は未読の Agent Session が居る Terminal Session の集合が変わるたびに呼ぶ。 */
export type Unread = (terminalSessionIds: string[]) => void

export function followUnread(deps: {
  db: Db
  events: EventPublisher<{ change: WorkbenchChange }>
  unread: Unread
}): () => void {
  const { db, events, unread } = deps
  let passed: string[] | null = null
  let queued = false

  function recount() {
    queued = false
    try {
      const terminalSessionIds = unreadTerminalSessions(db)
      if (passed && sameIds(passed, terminalSessionIds)) return
      unread(terminalSessionIds)
      passed = terminalSessionIds
    } catch (error) {
      console.error(`[workbench] could not pass the unread Terminal Sessions: ${error}`)
    }
  }

  recount()
  return events.subscribe('change', () => {
    if (queued) return
    queued = true
    // bun:sqlite の transaction は同期なので、transaction の中で出た合図でも microtask なら commit か rollback の後の行を数える。
    queueMicrotask(recount)
  })
}
