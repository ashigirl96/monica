import { ORPCError } from '@orpc/server'
import { and, eq, getTableColumns, ne } from 'drizzle-orm'

import type { AgentSession, ListedAgentSession } from './contract.ts'
import { decodeHook } from './hook-decoder.ts'
import { agentSession, terminalSession } from './schema.ts'
import { isLive } from './terminal-session.ts'
import { notificationFor, supersede, takesOverTerminal, transition } from './transition.ts'
import { isUnread } from './unread.ts'
import { type Db, notifyWaiting, type Tx, type WorkbenchContext } from './workbench.ts'

const notEnded = ne(agentSession.state, 'ended')

export function listAgentSessions(db: Db): ListedAgentSession[] {
  return db
    .select()
    .from(agentSession)
    .where(notEnded)
    .orderBy(agentSession.firstSeenAt)
    .all()
    .map((row) => ({ ...row, unread: isUnread(row) }))
}

export function markSeenIfUnread(
  db: Db,
  { sessionId, notifiedAt }: { sessionId: string; notifiedAt: Date },
): boolean {
  const bySessionId = eq(agentSession.sessionId, sessionId)
  const row = db
    .select({ notifiedAt: agentSession.notifiedAt, seenAt: agentSession.seenAt })
    .from(agentSession)
    .where(bySessionId)
    .get()
  if (!row) throw new ORPCError('NOT_FOUND', { message: `no Agent Session ${sessionId}` })
  // 画面が見てから届くまでの間に次の通知が出ていたら、その通知はまだ見ていない。
  if (!isUnread(row) || row.notifiedAt?.getTime() !== notifiedAt.getTime()) return false
  db.update(agentSession).set({ seenAt: new Date() }).where(bySessionId).run()
  return true
}

export function recordHook(
  { db, workbenchLedger }: WorkbenchContext,
  input: { terminalSessionId: string; payload: Record<string, unknown> },
): string[] {
  const { terminalSessionId, payload } = input
  const event = decodeHook(payload, terminalSessionId)
  if (!event) {
    console.error(`[workbench] ignored a hook it cannot read: ${String(payload.hook_event_name)}`)
    return []
  }
  const now = new Date()
  const recorded = db.transaction((tx) => {
    const host = tx
      .select({ status: terminalSession.status })
      .from(terminalSession)
      .where(eq(terminalSession.id, terminalSessionId))
      .get()
    // Tab の外へ漏れた env の agent は観測しない。
    if (!host || !isLive(host.status)) {
      console.error(
        `[workbench] dropped a ${event.hookEventName} hook from Terminal Session ${terminalSessionId} (${host?.status ?? 'not in the Workbench Ledger'})`,
      )
      return null
    }
    const own =
      tx.select().from(agentSession).where(eq(agentSession.sessionId, event.sessionId)).get() ??
      null
    const beside = tx
      .select()
      .from(agentSession)
      .where(
        and(
          eq(agentSession.terminalSessionId, terminalSessionId),
          ne(agentSession.sessionId, event.sessionId),
          notEnded,
        ),
      )
      .all()
    const next = transition(own, event, now)
    const reason = next && notificationFor(own, event, next)
    const after = next && reason ? { ...next, notifiedAt: now } : next
    const displaced = takesOverTerminal(own, after, event)
      ? beside.map((row) => supersede(row, now))
      : []
    return { changed: saveChanged(tx, [...displaced, after]), after, reason }
  })
  if (!recorded) return []
  const { changed, after, reason } = recorded
  if (after && reason) notifyWaiting(workbenchLedger, after, reason)
  return changed
}

export function endAgentSessionsIn(tx: Tx, terminalSessionId: string, now: Date): string[] {
  const live = tx
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.terminalSessionId, terminalSessionId), notEnded))
    .all()
  return saveChanged(
    tx,
    live.map((row) => transition(row, { type: 'terminalEnded' }, now)),
  )
}

export function reconcileAgentSessions(
  tx: Tx,
  { backendRestarted }: { backendRestarted: boolean },
): string[] {
  const now = new Date()
  const rows = tx
    .select({ ...getTableColumns(agentSession), hostStatus: terminalSession.status })
    .from(agentSession)
    .innerJoin(terminalSession, eq(terminalSession.id, agentSession.terminalSessionId))
    .where(notEnded)
    .all()
  return saveChanged(
    tx,
    rows.map(({ hostStatus, ...row }) => {
      if (!isLive(hostStatus)) return transition(row, { type: 'terminalEnded' }, now)
      return backendRestarted ? transition(row, { type: 'backendRestarted' }, now) : null
    }),
  )
}

function saveChanged(tx: Tx, rows: (AgentSession | null)[]): string[] {
  return rows.flatMap((row) => {
    if (!row) return []
    tx.insert(agentSession)
      .values(row)
      .onConflictDoUpdate({ target: agentSession.sessionId, set: row })
      .run()
    return [row.sessionId]
  })
}
