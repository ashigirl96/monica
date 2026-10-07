import { userInfo } from 'node:os'

import { EventPublisher } from '@orpc/server'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { readAgentSessionTitle } from './agent-session-title.ts'
import type { AgentSession, WorkbenchChange } from './contract.ts'
import { createRunspace, moveTab, openTab, removeRunspace } from './layout.ts'
import { shortPath } from './paths.ts'
import { openDaemon, type PtydClient } from './ptyd.ts'
import { writeTabFiles } from './tab-env.ts'
import { createTerminalSessions, type Size, type TerminalSessions } from './terminal-session.ts'
import { followUnread } from './unread.ts'

export type Db = BunSQLiteDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type WorkbenchContext = { db: Db; workbenchLedger: WorkbenchLedger }

export type WorkbenchLedger = {
  events: EventPublisher<{ change: WorkbenchChange }>
  start(): Promise<void>
  stop(): void
  createRunspace(tx: Tx, input: { cwd: string }): string
  /** shell は transaction の後に起こし、起きたら input を打つ。 */
  openTab(
    tx: Tx,
    input: { runspaceId: string; cwd?: string; size?: Size; input?: string },
  ): { tabId: string; terminalSessionId: string }
  moveTab(tx: Tx, tabId: string, runspaceId: string): void
  /** 消した Tab の Terminal Session は transaction の後に終わらせる。 */
  removeRunspace(tx: Tx, id: string, options?: { spare?: string[] }): void
}

export type NotificationDeps = {
  notify: (n: { title: string; body: string }) => void
  nameAgentSession: (db: Db, agentSessionId: string) => string | null
}

/** 未読の数。start() で 1 回、以降は数が変わるたびに呼ぶ。 */
export type Badge = (count: number) => void

type Internals = NotificationDeps & {
  db: Db
  terminalSessions: TerminalSessions
}

// WorkbenchLedger の型は他の domain が呼ぶものだけに保ち、ptyd の接続などの中身は WorkbenchLedger を key にここへ置く。
const internalsOf = new WeakMap<WorkbenchLedger, Internals>()

function internals(workbenchLedger: WorkbenchLedger): Internals {
  const found = internalsOf.get(workbenchLedger)
  if (!found) throw new Error('this WorkbenchLedger was not made by createWorkbenchLedger')
  return found
}

export function terminalSessionsOf(workbenchLedger: WorkbenchLedger): TerminalSessions {
  return internals(workbenchLedger).terminalSessions
}

export function createWorkbenchLedger(
  deps: NotificationDeps & { db: Db; home: string; ptydPath: string; badge: Badge },
): WorkbenchLedger {
  const { db, home, ptydPath, notify, nameAgentSession, badge } = deps
  const events = new EventPublisher<{ change: WorkbenchChange }>()
  const publish = (change: WorkbenchChange) => events.publish('change', change)

  let stopBadging: (() => void) | null = null
  let client: PtydClient | null = null
  let connection: Promise<PtydClient> | null = null
  // List を待つ間に届いた Exit は、まだ取り込んでいない行に当たらず Reap する接続も無いので、reconcile の後で当てる。
  let exitsDuringReconcile: [string, number | null][] | null = null
  // ptyd へ繋ぎ直す間も hook は届いているので、未観測にするのは Backend の起動直後の reconcile だけ。
  let backendRestarted = true
  let stopping = false

  const terminalSessions = createTerminalSessions({
    db,
    home,
    shell: process.env.SHELL || userInfo().shell || '/bin/zsh',
    publish,
    ready,
    stopping: () => stopping,
  })

  function onExit(id: string, exitCode: number | null) {
    if (exitsDuringReconcile) {
      exitsDuringReconcile.push([id, exitCode])
      return
    }
    terminalSessions.recordExit(client, id, exitCode)
  }

  // 繋ぎ直すのは reconcile まで済んだ接続が切れたときだけ。hello や List の途中で切れたら、
  // その connect を回している reconnect が retry するので、ここで 2 本目のループを始めない。
  function onClose() {
    const wasConnected = client !== null
    client = null
    if (stopping || !wasConnected) return
    console.error('[workbench] lost tania-ptyd; reconnecting')
    connection = reconnect()
    // 待つ呼び手が居ないまま stop() で reject しても unhandled にしない。
    connection.catch(() => {})
  }

  async function connect(): Promise<PtydClient> {
    if (stopping) throw new Error('the Workbench Ledger has stopped')
    exitsDuringReconcile = []
    try {
      const opened = await openDaemon({ home, ptydPath }, { onExit, onClose })
      if (stopping) {
        opened.close()
        throw new Error('the Workbench Ledger has stopped')
      }
      const { reaped, terminated, agentSessionIds } = terminalSessions.reconcile(
        opened,
        await opened.list(),
        { backendRestarted },
      )
      backendRestarted = false
      client = opened
      const exits = exitsDuringReconcile
      exitsDuringReconcile = null
      for (const [id, exitCode] of exits) onExit(id, exitCode)
      for (const sessionId of agentSessionIds) publish({ type: 'agentSession', sessionId })
      publish({ type: 'reconciled' })
      terminalSessions.respawnPinnedTabs()
      console.error(
        `[workbench] connected to tania-ptyd; reaped ${reaped}, terminated ${terminated}`,
      )
      return opened
    } finally {
      exitsDuringReconcile = null
    }
  }

  async function reconnect(): Promise<PtydClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await connect()
      } catch (error) {
        if (stopping) throw error
        console.error(`[workbench] tania-ptyd connection failed: ${error}`)
        await Bun.sleep(Math.min(5000, 200 * 2 ** attempt))
      }
    }
  }

  // ptyd に送るものはすべて reconcile の完了を待つ。起動時の List と競う Create を、
  // ptyd が失った行と取り違えないため。
  function ready(): Promise<PtydClient> {
    if (stopping) return Promise.reject(new Error('the Workbench Ledger has stopped'))
    connection ??= reconnect()
    return connection
  }

  const workbenchLedger: WorkbenchLedger = {
    events,
    async start() {
      try {
        writeTabFiles(home)
      } catch (error) {
        console.error(`[workbench] could not write the Tab's shell files: ${error}`)
      }
      stopBadging = followUnread({ db, events, badge })
      await ready()
    },
    stop() {
      stopping = true
      stopBadging?.()
      client?.close()
    },
    createRunspace(tx, { cwd }) {
      const id = createRunspace(tx, { cwd, owned: true })
      publish({ type: 'layout' })
      return id
    },
    openTab(tx, input) {
      const opened = openTab(tx, terminalSessions, input)
      publish({ type: 'layout' })
      return { tabId: opened.id, terminalSessionId: opened.terminalSessionId }
    },
    moveTab(tx, tabId, runspaceId) {
      moveTab(tx, { id: tabId, runspaceId })
      publish({ type: 'layout' })
    },
    removeRunspace(tx, id, options) {
      removeRunspace(tx, terminalSessions, id, options)
      publish({ type: 'layout' })
    },
  }
  internalsOf.set(workbenchLedger, { db, terminalSessions, notify, nameAgentSession })
  return workbenchLedger
}

// 通知は commit した後の副作用なので、出せなくても hook の記録と変更の合図は止めない。
export function notifyWaiting(
  workbenchLedger: WorkbenchLedger,
  agentSession: AgentSession,
  reason: string,
) {
  const { db, notify, nameAgentSession } = internals(workbenchLedger)
  try {
    const title = nameAgentSession(db, agentSession.sessionId) ?? shortPath(agentSession.cwd)
    const agentSessionTitle = readAgentSessionTitle(agentSession.transcriptPath)
    notify({ title, body: agentSessionTitle ? `${reason} · ${agentSessionTitle}` : reason })
  } catch (error) {
    console.error(`[workbench] could not notify for ${agentSession.sessionId}: ${error}`)
  }
}
