import { and, eq, inArray } from 'drizzle-orm'

import { endAgentSessionsIn, reconcileAgentSessions } from './agent-session.ts'
import type { TerminalSession, WorkbenchChange } from './contract.ts'
import { shouldRespawn } from './pin.ts'
import type { PtydClient, SessionInfo } from './ptyd.ts'
import { tab, terminalSession } from './schema.ts'
import { tabEnv } from './tab-env.ts'
import type { Db, Tx } from './workbench.ts'

export type Size = { rows: number; cols: number }

export const LIVE = ['starting', 'running'] as const

export function isLive(status: TerminalSession['status']): boolean {
  return (LIVE as readonly string[]).includes(status)
}

// 画面に出ていない Tab の shell は決まった大きさで起こし、attach の resize で追いつかせる。
const DEFAULT_SIZE: Size = { rows: 24, cols: 80 }

export type TerminalSessions = ReturnType<typeof createTerminalSessions>

// bun:sqlite の transaction は同期なので、microtask は commit か rollback の後に動く。
const afterTransaction = (work: () => void) => queueMicrotask(work)

// shell の起動は待たない。起動前の shell に書いた入力も捨てられずに評価される。
async function write(ptyd: PtydClient, id: string, data: string) {
  const outcome = await ptyd.write(id, data)
  if (outcome.kind === 'done') return
  const reason = outcome.kind === 'refused' ? outcome.error : 'the connection to tania-ptyd closed'
  console.error(`[workbench] could not type into Terminal Session ${id}: ${reason}`)
}

export function createTerminalSessions(deps: {
  db: Db
  home: string
  shell: string
  publish: (change: WorkbenchChange) => void
  ready: () => Promise<PtydClient>
  stopping: () => boolean
}) {
  const { db, home, shell, publish, ready } = deps
  // ここにある Terminal Session は ptyd がまだ知らないので、reconcile で lost にしない。
  const createNotSent = new Set<string>()

  function inBackground(work: Promise<void>, what: string) {
    work.catch((error: unknown) => {
      if (!deps.stopping()) console.error(`[workbench] ${what} failed: ${error}`)
    })
  }

  function start(
    tx: Tx,
    { cwd, size = DEFAULT_SIZE, input }: { cwd: string; size?: Size; input?: string },
  ): string {
    const id = `ts-${Bun.randomUUIDv7()}`
    tx.insert(terminalSession)
      .values({ id, cwd, shell, status: 'starting', createdAt: new Date() })
      .run()
    createNotSent.add(id)
    afterTransaction(() => inBackground(create(id, size, input), `starting Terminal Session ${id}`))
    return id
  }

  function rebind(tx: Tx, target: { id: string; cwd: string }, size?: Size) {
    const bound = tx
      .update(tab)
      .set({ terminalSessionId: start(tx, { cwd: target.cwd, size }) })
      .where(eq(tab.id, target.id))
      .returning()
      .get()
    if (!bound) throw new Error(`no Tab ${target.id}`)
    return bound
  }

  function startingRow(id: string) {
    const row = db.select().from(terminalSession).where(eq(terminalSession.id, id)).get()
    return row?.status === 'starting' ? row : undefined
  }

  // rollback された行は無いので、Create を送らずに集合から外す。
  async function create(id: string, { rows, cols }: Size, input: string | undefined) {
    while (startingRow(id)) {
      const ptyd = await ready()
      const row = startingRow(id)
      if (!row) break
      // 待つ間に接続が切れたら、繋ぎ直した reconcile の後に送る。
      if (ptyd.isClosed()) continue
      createNotSent.delete(id)
      // 即死した shell の Exit は Created の応答より先に届くことがあるので、starting の行だけを進める。
      const stillStarting = and(eq(terminalSession.id, id), eq(terminalSession.status, 'starting'))
      const outcome = await ptyd.create({
        session_id: id,
        cwd: row.cwd,
        shell: row.shell,
        rows,
        cols,
        env: tabEnv(home, id),
      })
      switch (outcome.kind) {
        case 'done':
          db.update(terminalSession)
            .set({ status: 'running', pid: outcome.value })
            .where(stillStarting)
            .run()
          break
        case 'refused':
          db.update(terminalSession)
            .set({ status: 'failed', error: outcome.error, endedAt: new Date() })
            .where(stillStarting)
            .run()
          break
        // ptyd が作ったかは分からないので、starting のまま繋ぎ直した後の reconcile に決めさせる。
        case 'unknown':
          if (input !== undefined) await typeAfterReconcile(id, input)
          return
      }
      publish({ type: 'terminalSession', id })
      if (outcome.kind === 'done' && input !== undefined) await write(ptyd, id, input)
      return
    }
    createNotSent.delete(id)
  }

  async function typeAfterReconcile(id: string, input: string) {
    const ptyd = await ready()
    const row = db.select().from(terminalSession).where(eq(terminalSession.id, id)).get()
    if (row?.status === 'running') await write(ptyd, id, input)
    else
      console.error(
        `[workbench] could not type into Terminal Session ${id}: it is ${row?.status ?? 'gone'}`,
      )
  }

  // rollback されていれば消した Tab が残っているので、Terminate を送らない。
  function terminateRemoved(removed: { tabId: string; terminalSessionId: string }[]) {
    if (removed.length === 0) return
    afterTransaction(() => {
      const tabIds = removed.map((r) => r.tabId)
      if (db.select({ id: tab.id }).from(tab).where(inArray(tab.id, tabIds)).get()) return
      terminate(removed.map((r) => r.terminalSessionId))
    })
  }

  function terminate(ids: string[]) {
    for (const id of ids) inBackground(sendTerminate(id), `terminating Terminal Session ${id}`)
  }

  // Terminate は冪等なので、送る途中で接続が切れたら繋ぎ直した ptyd に送り直す。
  async function sendTerminate(id: string) {
    for (;;) {
      const outcome = await (await ready()).terminate(id)
      if (outcome.kind === 'unknown') continue
      if (outcome.kind === 'refused') throw new Error(outcome.error)
      return
    }
  }

  // Reap は commit の後にする。間で Backend が死んでも tombstone が残り、次の reconcile が拾う。
  function recordExit(ptyd: PtydClient | null, id: string, exitCode: number | null) {
    const endedAt = new Date()
    const agentSessionIds = db.transaction((tx) => {
      tx.update(terminalSession)
        .set({ status: 'exited', exitCode, endedAt })
        .where(and(eq(terminalSession.id, id), inArray(terminalSession.status, LIVE)))
        .run()
      return endAgentSessionsIn(tx, id, endedAt)
    })
    publish({ type: 'terminalSession', id })
    for (const sessionId of agentSessionIds) publish({ type: 'agentSession', sessionId })
    ptyd?.reap(id)
    respawnPinnedTabs([id])
  }

  // id を省くと pin された Tab をすべて見る。Exit の記録と張り直しの間で Backend が止まった分も拾うため。
  function respawnPinnedTabs(endedIds?: string[]) {
    try {
      const respawned = db.transaction((tx) =>
        tx
          .select()
          .from(terminalSession)
          .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
          .where(endedIds ? inArray(terminalSession.id, endedIds) : eq(tab.pinned, true))
          .all()
          .flatMap((row) =>
            row.tab && shouldRespawn(row.terminal_session, row.tab) ? [rebind(tx, row.tab)] : [],
          ),
      )
      if (respawned.length > 0) publish({ type: 'layout' })
    } catch (error) {
      console.error(`[workbench] respawning pinned Tabs failed: ${error}`)
    }
  }

  function reconcile(
    ptyd: PtydClient,
    ptydSessions: SessionInfo[],
    { backendRestarted }: { backendRestarted: boolean },
  ) {
    const now = new Date()
    const unmatched = new Map(ptydSessions.map((s) => [s.session_id, s]))
    const toReap: string[] = []
    const toTerminate: string[] = []
    const agentSessionIds = db.transaction((tx) => {
      for (const row of tx.select().from(terminalSession).all()) {
        const held = unmatched.get(row.id)
        unmatched.delete(row.id)
        if (!isLive(row.status)) {
          // 終わった行は生き返らないので、同じ id で ptyd に残るものはどこからも辿れない。
          if (held?.running) toTerminate.push(row.id)
          else if (held) toReap.push(row.id)
          continue
        }
        if (!held) {
          if (createNotSent.has(row.id)) continue
          tx.update(terminalSession)
            .set({ status: 'lost', endedAt: now })
            .where(eq(terminalSession.id, row.id))
            .run()
          continue
        }
        if (!held.running) {
          tx.update(terminalSession)
            .set({ status: 'exited', exitCode: held.exit_code, endedAt: now })
            .where(eq(terminalSession.id, row.id))
            .run()
          toReap.push(row.id)
          continue
        }
        tx.update(terminalSession)
          .set({ status: 'running', pid: held.pid })
          .where(eq(terminalSession.id, row.id))
          .run()
      }
      // DB を消した後や Create と INSERT の間の crash で、ptyd にだけ残った session。
      for (const held of unmatched.values()) {
        if (!held.running) {
          toReap.push(held.session_id)
          continue
        }
        tx.insert(terminalSession)
          .values({
            id: held.session_id,
            cwd: held.cwd,
            shell: '',
            status: 'running',
            pid: held.pid,
            createdAt: now,
          })
          .run()
      }
      return reconcileAgentSessions(tx, { backendRestarted })
    })
    for (const id of toReap) ptyd.reap(id)
    terminate(toTerminate)
    return { reaped: toReap.length, terminated: toTerminate.length, agentSessionIds }
  }

  return {
    start,
    rebind,
    terminateRemoved,
    terminate,
    recordExit,
    respawnPinnedTabs,
    reconcile,
  }
}
