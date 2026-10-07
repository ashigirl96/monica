import type { EventPublisher } from '@orpc/server'
import { ne } from 'drizzle-orm'

import type { AgentSession, WorkbenchChange } from './contract.ts'
import { agentSession } from './schema.ts'
import type { Badge, Db } from './workbench.ts'

export function isUnread(row: Pick<AgentSession, 'notifiedAt' | 'seenAt'>): boolean {
  return row.notifiedAt !== null && row.seenAt === null
}

function countUnread(db: Db): number {
  // 終わった行は未読でなく、消さずに溜まるので読まない。
  return db
    .select({ notifiedAt: agentSession.notifiedAt, seenAt: agentSession.seenAt })
    .from(agentSession)
    .where(ne(agentSession.state, 'ended'))
    .all()
    .filter(isUnread).length
}

export function followUnread(deps: {
  db: Db
  events: EventPublisher<{ change: WorkbenchChange }>
  badge: Badge
}): () => void {
  const { db, events, badge } = deps
  let badged: number | null = null
  let queued = false

  function recount() {
    queued = false
    try {
      const count = countUnread(db)
      if (count === badged) return
      badge(count)
      badged = count
    } catch (error) {
      console.error(`[workbench] could not badge the unread count: ${error}`)
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
