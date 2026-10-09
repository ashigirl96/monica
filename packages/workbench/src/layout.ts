import { homedir } from 'node:os'

import { ORPCError } from '@orpc/server'
import { and, eq, notInArray } from 'drizzle-orm'

import type { Layout, Tab, WorkbenchChange } from './contract.ts'
import type { Db, Tx } from './db.ts'
import { runspace, tab, terminalSession } from './schema.ts'
import { isLive } from './terminal-session-status.ts'
import type { Size, TerminalSessions } from './terminal-session.ts'

export function readLayout(db: Db): Layout {
  const tabs = db.select().from(tab).orderBy(tab.sortOrder).all()
  return {
    runspaces: db
      .select()
      .from(runspace)
      .orderBy(runspace.sortOrder)
      .all()
      .map((r) => ({ ...r, tabs: tabs.filter((t) => t.runspaceId === r.id).map(asTab) })),
  }
}

export function asTab(row: typeof tab.$inferSelect): Tab {
  const { runspaceId: _, ...rest } = row
  return rest
}

export type LayoutWrites = ReturnType<typeof createLayoutWrites>

/** 各 method は Runspace と Tab の行を書いた transaction の中で `{ type: "layout" }` を 1 つ publish する。 */
export function createLayoutWrites(deps: {
  publish: (change: WorkbenchChange) => void
  terminalSessions: TerminalSessions
}) {
  const { publish, terminalSessions } = deps
  const signalLayout = () => publish({ type: 'layout' })

  function insertTab(
    tx: Tx,
    input: { runspaceId: string; cwd?: string; index?: number; size?: Size; input?: string },
  ) {
    const { runspaceId } = input
    const runspaceCwd = runspaceOf(tx, runspaceId).cwd
    const cwd = input.cwd ?? runspaceCwd
    const terminalSessionId = terminalSessions.start(tx, {
      cwd,
      size: input.size,
      input: input.input,
    })
    const id = `tab-${Bun.randomUUIDv7()}`
    const order = insertAt(tabIds(tx, runspaceId), id, input.index)
    const opened = tx
      .insert(tab)
      .values({ id, runspaceId, cwd, sortOrder: order.indexOf(id), terminalSessionId })
      .returning()
      .get()
    restack(tx, tab, order)
    return opened
  }

  /**
   * `spare` の Terminal Session の Tab が中にあれば、Runspace を消さずに所有を解いてその Tab だけを残す。
   * 消した Tab の Terminal Session は transaction の後に終わらせる。
   */
  function dropRunspace(tx: Tx, id: string, { spare = [] }: { spare?: string[] } = {}) {
    runspaceOf(tx, id)
    const tabs = tx
      .select({ tabId: tab.id, terminalSessionId: tab.terminalSessionId })
      .from(tab)
      .where(eq(tab.runspaceId, id))
      .orderBy(tab.sortOrder)
      .all()
    const kept = tabs.filter((t) => spare.includes(t.terminalSessionId))
    terminalSessions.terminateRemoved(tabs.filter((t) => !kept.includes(t)))
    if (kept.length === 0) {
      deleteRunspace(tx, id)
      return
    }
    const keptIds = kept.map((t) => t.tabId)
    tx.delete(tab)
      .where(and(eq(tab.runspaceId, id), notInArray(tab.id, keptIds)))
      .run()
    tx.update(runspace).set({ owned: false }).where(eq(runspace.id, id)).run()
    restack(tx, tab, keptIds)
  }

  return {
    openRunspace(tx: Tx, input: { cwd: string; index?: number; size?: Size }) {
      const opened = insertTab(tx, {
        runspaceId: createRunspace(tx, { cwd: input.cwd, index: input.index }),
        cwd: input.cwd,
        size: input.size,
      })
      signalLayout()
      return opened
    },
    createOwnedRunspace(tx: Tx, input: { cwd: string }): string {
      const id = createRunspace(tx, { cwd: input.cwd, owned: true })
      signalLayout()
      return id
    },
    removeRunspace(tx: Tx, id: string) {
      if (runspaceOf(tx, id).owned) {
        throw new ORPCError('CONFLICT', { message: `Runspace ${id} is owned by another domain` })
      }
      if (pinnedTabOf(tx, id)) {
        throw new ORPCError('CONFLICT', { message: `Runspace ${id} holds a pinned Tab` })
      }
      dropRunspace(tx, id)
      signalLayout()
    },
    removeOwnedRunspace(tx: Tx, id: string, options?: { spare?: string[] }) {
      dropRunspace(tx, id, options)
      signalLayout()
    },
    moveRunspace(tx: Tx, input: { id: string; index: number }) {
      runspaceOf(tx, input.id)
      restack(tx, runspace, insertAt(runspaceIds(tx), input.id, input.index))
      signalLayout()
    },
    openTab(
      tx: Tx,
      input: { runspaceId: string; cwd?: string; index?: number; size?: Size; input?: string },
    ) {
      const opened = insertTab(tx, input)
      signalLayout()
      return opened
    },
    closeTab(tx: Tx, id: string): { emptiedRunspaceId: string | null } {
      const closed = tabOf(tx, id)
      if (closed.pinned) throw new ORPCError('CONFLICT', { message: `Tab ${id} is pinned` })
      tx.delete(tab).where(eq(tab.id, id)).run()
      terminalSessions.terminateRemoved([
        { tabId: id, terminalSessionId: closed.terminalSessionId },
      ])
      const emptied = afterTabLeft(tx, closed.runspaceId)
      signalLayout()
      return { emptiedRunspaceId: emptied ? closed.runspaceId : null }
    },
    moveTab(tx: Tx, input: { id: string; runspaceId: string; index?: number }) {
      relocateTab(tx, input)
      signalLayout()
    },
    pinTab(tx: Tx, id: string) {
      const target = tabOf(tx, id)
      const holder = pinnedTabOf(tx, target.runspaceId)
      if (holder) {
        tx.update(tab).set({ pinned: false }).where(eq(tab.id, holder.id)).run()
      } else if (
        !runspaceOf(tx, target.runspaceId).owned &&
        tabIds(tx, target.runspaceId).length > 1
      ) {
        relocateTab(tx, { id, runspaceId: createRunspace(tx, { cwd: target.cwd }) })
      }
      tx.update(tab).set({ pinned: true }).where(eq(tab.id, id)).run()
      signalLayout()
    },
    unpinTab(tx: Tx, id: string) {
      tabOf(tx, id)
      tx.update(tab).set({ pinned: false }).where(eq(tab.id, id)).run()
      signalLayout()
    },
    // title から取った cwd は `~` で始まるが、Workbench Ledger の cwd は git や fs にそのまま渡すので絶対 path にする。
    setTabCwd(tx: Tx, input: { id: string; cwd: string }) {
      tabOf(tx, input.id)
      const cwd =
        input.cwd === '~' || input.cwd.startsWith('~/') ? homedir() + input.cwd.slice(1) : input.cwd
      tx.update(tab).set({ cwd }).where(eq(tab.id, input.id)).run()
      signalLayout()
    },
    // 合図は Tab を結び直す rebind が出す。
    respawnTab(tx: Tx, id: string, size: Size) {
      const { cwd, terminalSessionId } = tabOf(tx, id)
      const { status } = tx
        .select({ status: terminalSession.status })
        .from(terminalSession)
        .where(eq(terminalSession.id, terminalSessionId))
        .get()!
      if (isLive(status)) {
        throw new ORPCError('CONFLICT', {
          message: `Tab ${id} still shows a live Terminal Session`,
        })
      }
      return terminalSessions.rebind(tx, { id, cwd }, size)
    },
  }
}

function createRunspace(tx: Tx, input: { cwd: string; index?: number; owned?: boolean }): string {
  const id = `rs-${Bun.randomUUIDv7()}`
  const order = insertAt(runspaceIds(tx), id, input.index)
  tx.insert(runspace)
    .values({ id, cwd: input.cwd, sortOrder: order.indexOf(id), owned: input.owned })
    .run()
  restack(tx, runspace, order)
  return id
}

function relocateTab(tx: Tx, input: { id: string; runspaceId: string; index?: number }) {
  const moved = tabOf(tx, input.id)
  runspaceOf(tx, input.runspaceId)
  const pinned = moved.pinned && moved.runspaceId === input.runspaceId
  // 移る先に pin された Tab があっても部分 unique index に当たらないよう、pin は同じ UPDATE で外す。
  tx.update(tab).set({ runspaceId: input.runspaceId, pinned }).where(eq(tab.id, input.id)).run()
  restack(tx, tab, insertAt(tabIds(tx, input.runspaceId), input.id, input.index))
  if (moved.runspaceId !== input.runspaceId) afterTabLeft(tx, moved.runspaceId)
}

function runspaceOf(tx: Tx, id: string) {
  const found = tx.select().from(runspace).where(eq(runspace.id, id)).get()
  if (!found) throw new ORPCError('NOT_FOUND', { message: `no Runspace ${id}` })
  return found
}

function tabOf(tx: Tx, id: string) {
  const found = tx.select().from(tab).where(eq(tab.id, id)).get()
  if (!found) throw new ORPCError('NOT_FOUND', { message: `no Tab ${id}` })
  return found
}

function pinnedTabOf(tx: Tx, runspaceId: string) {
  return tx
    .select({ id: tab.id })
    .from(tab)
    .where(and(eq(tab.runspaceId, runspaceId), eq(tab.pinned, true)))
    .get()
}

// 所有されていない Runspace は Tab を 1 つ以上持つので、最後の Tab が抜けたら Runspace ごと消す。
/** 所有された Runspace が Tab の無いまま残ったら true。 */
function afterTabLeft(tx: Tx, runspaceId: string): boolean {
  const rest = tabIds(tx, runspaceId)
  if (rest.length > 0) {
    restack(tx, tab, rest)
    return false
  }
  if (runspaceOf(tx, runspaceId).owned) return true
  deleteRunspace(tx, runspaceId)
  return false
}

function deleteRunspace(tx: Tx, id: string) {
  tx.delete(runspace).where(eq(runspace.id, id)).run()
  restack(tx, runspace, runspaceIds(tx))
}

function runspaceIds(tx: Tx): string[] {
  return tx
    .select({ id: runspace.id })
    .from(runspace)
    .orderBy(runspace.sortOrder)
    .all()
    .map((r) => r.id)
}

function tabIds(tx: Tx, runspaceId: string): string[] {
  return tx
    .select({ id: tab.id })
    .from(tab)
    .where(eq(tab.runspaceId, runspaceId))
    .orderBy(tab.sortOrder)
    .all()
    .map((t) => t.id)
}

function insertAt(siblings: string[], id: string, index: number | undefined): string[] {
  const order = siblings.filter((sibling) => sibling !== id)
  order.splice(index ?? order.length, 0, id)
  return order
}

function restack(tx: Tx, table: typeof runspace | typeof tab, order: string[]) {
  order.forEach((id, sortOrder) => {
    tx.update(table).set({ sortOrder }).where(eq(table.id, id)).run()
  })
}
