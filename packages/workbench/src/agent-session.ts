import { ORPCError } from '@orpc/server'
import { and, eq, getTableColumns, ne } from 'drizzle-orm'

import { readAgentSessionTitle } from './agent-session-title.ts'
import type { AgentSession, ListedAgentSession, WorkbenchChange } from './contract.ts'
import type { Db, Tx } from './db.ts'
import { decodeHook } from './hook-decoder.ts'
import { shortPath } from './paths.ts'
import { agentSession, terminalSession } from './schema.ts'
import { isLive } from './terminal-session-status.ts'
import { notificationFor, supersede, takesOverTerminal, transition } from './transition.ts'
import { isUnread } from './unread.ts'

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

export type NotificationDeps = {
  notify: (n: { title: string; body: string; terminalSessionId: string }) => void
  nameAgentSession: (db: Db, agentSessionId: string) => string | null
}

export type AgentSessions = ReturnType<typeof createAgentSessions>

export function createAgentSessions(
  deps: NotificationDeps & { db: Db; publish: (change: WorkbenchChange) => void },
) {
  const { db, publish, notify, nameAgentSession } = deps

  function recordHook(input: { terminalSessionId: string; payload: Record<string, unknown> }) {
    const { terminalSessionId, payload } = input
    const event = decodeHook(payload, terminalSessionId)
    if (!event) {
      console.error(`[workbench] ignored a hook it cannot read: ${String(payload.hook_event_name)}`)
      return
    }
    const now = new Date()
    const waiting = db.transaction((tx) => {
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
      saveAndSignal(tx, [...displaced, after])
      return after && reason ? { after, reason } : null
    })
    if (waiting) notifyWaiting(waiting.after, waiting.reason)
  }

  function markSeen({ sessionId, notifiedAt }: { sessionId: string; notifiedAt: Date }) {
    const bySessionId = eq(agentSession.sessionId, sessionId)
    const row = db
      .select({ notifiedAt: agentSession.notifiedAt, seenAt: agentSession.seenAt })
      .from(agentSession)
      .where(bySessionId)
      .get()
    if (!row) throw new ORPCError('NOT_FOUND', { message: `no Agent Session ${sessionId}` })
    // 画面が見てから届くまでの間に次の通知が出ていたら、その通知はまだ見ていない。
    if (!isUnread(row) || row.notifiedAt?.getTime() !== notifiedAt.getTime()) return
    db.update(agentSession).set({ seenAt: new Date() }).where(bySessionId).run()
    publish({ type: 'agentSession', sessionId })
  }

  function endIn(tx: Tx, terminalSessionId: string, now: Date) {
    const live = tx
      .select()
      .from(agentSession)
      .where(and(eq(agentSession.terminalSessionId, terminalSessionId), notEnded))
      .all()
    saveAndSignal(
      tx,
      live.map((row) => transition(row, { type: 'terminalEnded' }, now)),
    )
  }

  function reconcile(tx: Tx, { backendRestarted }: { backendRestarted: boolean }) {
    const now = new Date()
    const rows = tx
      .select({ ...getTableColumns(agentSession), hostStatus: terminalSession.status })
      .from(agentSession)
      .innerJoin(terminalSession, eq(terminalSession.id, agentSession.terminalSessionId))
      .where(notEnded)
      .all()
    saveAndSignal(
      tx,
      rows.map(({ hostStatus, ...row }) => {
        if (!isLive(hostStatus)) return transition(row, { type: 'terminalEnded' }, now)
        return backendRestarted ? transition(row, { type: 'backendRestarted' }, now) : null
      }),
    )
  }

  function saveAndSignal(tx: Tx, rows: (AgentSession | null)[]) {
    for (const row of rows) {
      if (!row) continue
      tx.insert(agentSession)
        .values(row)
        .onConflictDoUpdate({ target: agentSession.sessionId, set: row })
        .run()
      publish({ type: 'agentSession', sessionId: row.sessionId })
    }
  }

  // 通知は commit した後の副作用なので、出せなくても記録した hook を失敗にしない。
  function notifyWaiting(row: AgentSession, reason: string) {
    try {
      const title = nameAgentSession(db, row.sessionId) ?? shortPath(row.cwd)
      const agentSessionTitle = readAgentSessionTitle(row.transcriptPath)
      notify({
        title,
        body: agentSessionTitle ? `${reason} · ${agentSessionTitle}` : reason,
        terminalSessionId: row.terminalSessionId,
      })
    } catch (error) {
      console.error(`[workbench] could not notify for ${row.sessionId}: ${error}`)
    }
  }

  return { recordHook, markSeen, endIn, reconcile }
}
