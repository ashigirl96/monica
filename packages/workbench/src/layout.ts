import { homedir } from "node:os";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { Layout, Tab } from "./contract.ts";
import { runspace, tab, terminalSession } from "./schema.ts";
import {
  bindNewTerminalSession,
  type Db,
  insertTerminalSession,
  isLive,
  shellWhenReady,
  type Size,
  startTerminalSession,
  type Tx,
  type Workbench,
} from "./workbench.ts";

type Books = { db: Db; workbench: Workbench };

export function readLayout(db: Db): Layout {
  const tabs = db.select().from(tab).orderBy(tab.sortOrder).all();
  return {
    runspaces: db
      .select()
      .from(runspace)
      .orderBy(runspace.sortOrder)
      .all()
      .map((r) => ({ ...r, tabs: tabs.filter((t) => t.runspaceId === r.id).map(asTab) })),
  };
}

export function asTab(row: typeof tab.$inferSelect): Tab {
  const { runspaceId: _, ...rest } = row;
  return rest;
}

export function writeLayout<T>({ db, workbench }: Books, write: (tx: Tx) => T): T {
  const written = db.transaction(write);
  workbench.events.publish("change", { type: "layout" });
  return written;
}

export function createRunspace(tx: Tx, input: { cwd: string; index?: number }): string {
  const id = `rs-${Bun.randomUUIDv7()}`;
  const order = insertAt(runspaceIds(tx), id, input.index);
  tx.insert(runspace)
    .values({ id, cwd: input.cwd, sortOrder: order.indexOf(id) })
    .run();
  restack(tx, runspace, order);
  return id;
}

export function refuseRemovingPinned(tx: Tx, runspaceId: string) {
  if (pinnedTabOf(tx, runspaceId)) {
    throw new ORPCError("CONFLICT", { message: `Runspace ${runspaceId} holds a pinned Tab` });
  }
}

export function removeRunspace(tx: Tx, id: string): string[] {
  runspaceOf(tx, id);
  const terminalSessionIds = tx
    .select({ id: tab.terminalSessionId })
    .from(tab)
    .where(eq(tab.runspaceId, id))
    .all()
    .map((t) => t.id);
  deleteRunspace(tx, id);
  return terminalSessionIds;
}

export function moveRunspace(tx: Tx, input: { id: string; index: number }) {
  runspaceOf(tx, input.id);
  restack(tx, runspace, insertAt(runspaceIds(tx), input.id, input.index));
}

export function openTab(
  tx: Tx,
  input: { runspaceId: string; cwd?: string; index?: number; shell: string },
) {
  const cwd = input.cwd ?? runspaceOf(tx, input.runspaceId).cwd;
  return attachTab(tx, {
    runspaceId: input.runspaceId,
    cwd,
    index: input.index,
    terminalSessionId: insertTerminalSession(tx, { cwd, shell: input.shell }),
  });
}

export function reattachTab(
  tx: Tx,
  input: { runspaceId: string; cwd?: string; index?: number; terminalSessionId: string },
) {
  const row = tx
    .select({ status: terminalSession.status, cwd: terminalSession.cwd, tabId: tab.id })
    .from(terminalSession)
    .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
    .where(eq(terminalSession.id, input.terminalSessionId))
    .get();
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: `no Terminal Session ${input.terminalSessionId}` });
  }
  if (row.tabId !== null || !isLive(row.status)) {
    throw new ORPCError("CONFLICT", {
      message: `Terminal Session ${input.terminalSessionId} is not detached`,
    });
  }
  return attachTab(tx, {
    runspaceId: input.runspaceId,
    cwd: input.cwd ?? row.cwd,
    index: input.index,
    terminalSessionId: input.terminalSessionId,
  });
}

export function moveTab(tx: Tx, input: { id: string; runspaceId: string; index?: number }) {
  const moved = tabOf(tx, input.id);
  runspaceOf(tx, input.runspaceId);
  const pinned = moved.pinned && moved.runspaceId === input.runspaceId;
  // 移る先に pin された Tab があっても部分 unique index に当たらないよう、pin は同じ UPDATE で外す。
  tx.update(tab).set({ runspaceId: input.runspaceId, pinned }).where(eq(tab.id, input.id)).run();
  restack(tx, tab, insertAt(tabIds(tx, input.runspaceId), input.id, input.index));
  if (moved.runspaceId !== input.runspaceId) afterTabLeft(tx, moved.runspaceId);
}

export function closeTab(tx: Tx, id: string) {
  const closed = tabOf(tx, id);
  if (closed.pinned) throw new ORPCError("CONFLICT", { message: `Tab ${id} is pinned` });
  tx.delete(tab).where(eq(tab.id, id)).run();
  afterTabLeft(tx, closed.runspaceId);
}

export function pinTab(tx: Tx, id: string) {
  const target = tabOf(tx, id);
  const holder = pinnedTabOf(tx, target.runspaceId);
  if (holder) {
    tx.update(tab).set({ pinned: false }).where(eq(tab.id, holder.id)).run();
  } else if (tabIds(tx, target.runspaceId).length > 1) {
    moveTab(tx, { id, runspaceId: createRunspace(tx, { cwd: target.cwd }) });
  }
  tx.update(tab).set({ pinned: true }).where(eq(tab.id, id)).run();
}

export function unpinTab(tx: Tx, id: string) {
  tabOf(tx, id);
  tx.update(tab).set({ pinned: false }).where(eq(tab.id, id)).run();
}

// title から取った cwd は `~` で始まるが、帳簿の cwd は git や fs にそのまま渡すので絶対 path にする。
export function setTabCwd(tx: Tx, input: { id: string; cwd: string }) {
  tabOf(tx, input.id);
  const cwd =
    input.cwd === "~" || input.cwd.startsWith("~/") ? homedir() + input.cwd.slice(1) : input.cwd;
  tx.update(tab).set({ cwd }).where(eq(tab.id, input.id)).run();
}

export async function respawnTab(books: Books, id: string, size: Size) {
  const shell = await shellWhenReady(books.workbench);
  const respawned = writeLayout(books, (tx) => {
    const { cwd, terminalSessionId } = tabOf(tx, id);
    const { status } = tx
      .select({ status: terminalSession.status })
      .from(terminalSession)
      .where(eq(terminalSession.id, terminalSessionId))
      .get()!;
    if (isLive(status)) {
      throw new ORPCError("CONFLICT", { message: `Tab ${id} still shows a live Terminal Session` });
    }
    return bindNewTerminalSession(tx, { id, cwd }, shell);
  });
  await startTerminalSession(books.workbench, respawned.terminalSessionId, size);
  return respawned;
}

function attachTab(
  tx: Tx,
  input: { runspaceId: string; cwd: string; index?: number; terminalSessionId: string },
) {
  const { runspaceId, cwd, terminalSessionId } = input;
  runspaceOf(tx, runspaceId);
  const id = `tab-${Bun.randomUUIDv7()}`;
  const order = insertAt(tabIds(tx, runspaceId), id, input.index);
  const attached = tx
    .insert(tab)
    .values({ id, runspaceId, cwd, sortOrder: order.indexOf(id), terminalSessionId })
    .returning()
    .get();
  restack(tx, tab, order);
  return attached;
}

function runspaceOf(tx: Tx, id: string) {
  const found = tx.select().from(runspace).where(eq(runspace.id, id)).get();
  if (!found) throw new ORPCError("NOT_FOUND", { message: `no Runspace ${id}` });
  return found;
}

function tabOf(tx: Tx, id: string) {
  const found = tx.select().from(tab).where(eq(tab.id, id)).get();
  if (!found) throw new ORPCError("NOT_FOUND", { message: `no Tab ${id}` });
  return found;
}

function pinnedTabOf(tx: Tx, runspaceId: string) {
  return tx
    .select({ id: tab.id })
    .from(tab)
    .where(and(eq(tab.runspaceId, runspaceId), eq(tab.pinned, true)))
    .get();
}

// 所有されていない Runspace は Tab を 1 つ以上持つので、最後の Tab が抜けたら Runspace ごと消す。
function afterTabLeft(tx: Tx, runspaceId: string) {
  const rest = tabIds(tx, runspaceId);
  if (rest.length > 0) restack(tx, tab, rest);
  else deleteRunspace(tx, runspaceId);
}

function deleteRunspace(tx: Tx, id: string) {
  tx.delete(runspace).where(eq(runspace.id, id)).run();
  restack(tx, runspace, runspaceIds(tx));
}

function runspaceIds(tx: Tx): string[] {
  return tx
    .select({ id: runspace.id })
    .from(runspace)
    .orderBy(runspace.sortOrder)
    .all()
    .map((r) => r.id);
}

function tabIds(tx: Tx, runspaceId: string): string[] {
  return tx
    .select({ id: tab.id })
    .from(tab)
    .where(eq(tab.runspaceId, runspaceId))
    .orderBy(tab.sortOrder)
    .all()
    .map((t) => t.id);
}

function insertAt(siblings: string[], id: string, index: number | undefined): string[] {
  const order = siblings.filter((sibling) => sibling !== id);
  order.splice(index ?? order.length, 0, id);
  return order;
}

function restack(tx: Tx, table: typeof runspace | typeof tab, order: string[]) {
  order.forEach((id, sortOrder) => {
    tx.update(table).set({ sortOrder }).where(eq(table.id, id)).run();
  });
}
