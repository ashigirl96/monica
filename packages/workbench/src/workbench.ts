import { userInfo } from "node:os";
import { EventPublisher } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { endAgentSessionsIn, reconcileAgentSessions } from "./agent-session.ts";
import type { AgentSession, TerminalSession, WorkbenchChange } from "./contract.ts";
import { createRunspace, moveTab, openTab, removeRunspace } from "./layout.ts";
import { shortPath } from "./paths.ts";
import { shouldRespawn } from "./pin.ts";
import { openDaemon, type PtydClient, type SessionInfo } from "./ptyd.ts";
import { tab, terminalSession } from "./schema.ts";
import { tabEnv, writeTabFiles } from "./tab-env.ts";

export type Db = BunSQLiteDatabase;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Books = { db: Db; workbench: Workbench };
export type Size = { rows: number; cols: number };

export const LIVE = ["starting", "running"] as const;

// 張り直す Tab は画面に出ていないこともあるので、決まった大きさで起こし、attach の resize で追いつかせる。
const RESPAWN_SIZE: Size = { rows: 24, cols: 80 };

export type Workbench = {
  events: EventPublisher<{ change: WorkbenchChange }>;
  start(): Promise<void>;
  stop(): void;
  /** reconcile より先に書いた starting の行は lost にされるので、openTab の transaction の前に待つ。 */
  ready(): Promise<void>;
  createRunspace(tx: Tx, input: { cwd: string }): string;
  openTab(
    tx: Tx,
    input: { runspaceId: string; cwd?: string },
  ): { tabId: string; terminalSessionId: string };
  moveTab(tx: Tx, tabId: string, runspaceId: string): void;
  /** 返した Terminal Session は、commit の後に terminateTerminalSessions で終わらせる。 */
  removeRunspace(tx: Tx, id: string, options?: { spare?: string }): string[];
  startTerminalSession(id: string, size: Size): Promise<void>;
  writeTerminalSession(id: string, data: string): Promise<void>;
  terminateTerminalSessions(ids: string[]): Promise<void>;
};

export type NotificationDeps = {
  notify: (n: { title: string; body: string }) => void;
  nameAgentSession: (db: Db, agentSessionId: string) => string | null;
};

type Internals = NotificationDeps & {
  db: Db;
  home: string;
  shell: string;
  publish: (change: WorkbenchChange) => void;
  ready: () => Promise<PtydClient>;
};

// Workbench の型は他の domain が呼ぶものだけに保ち、ptyd の接続などの中身は Workbench を key にここへ置く。
const internalsOf = new WeakMap<Workbench, Internals>();

function internals(workbench: Workbench): Internals {
  const found = internalsOf.get(workbench);
  if (!found) throw new Error("this Workbench was not made by createWorkbench");
  return found;
}

export function createWorkbench(
  deps: NotificationDeps & { db: Db; home: string; ptydPath: string },
): Workbench {
  const { db, home, ptydPath, notify, nameAgentSession } = deps;
  const events = new EventPublisher<{ change: WorkbenchChange }>();
  const publish = (change: WorkbenchChange) => events.publish("change", change);
  const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";

  let client: PtydClient | null = null;
  let connection: Promise<PtydClient> | null = null;
  // List を待つ間に届いた Exit は、まだ取り込んでいない行に当たらず Reap する接続も無いので、reconcile の後で当てる。
  let exitsDuringReconcile: [string, number | null][] | null = null;
  // ptyd へ繋ぎ直す間も hook は届いているので、未観測にするのは Backend の起動直後の reconcile だけ。
  let backendRestarted = true;
  let stopping = false;

  // Reap は commit の後にする。間で Backend が死んでも tombstone が残り、次の reconcile が拾う。
  function onExit(id: string, exitCode: number | null) {
    if (exitsDuringReconcile) {
      exitsDuringReconcile.push([id, exitCode]);
      return;
    }
    const endedAt = new Date();
    const agentSessionIds = db.transaction((tx) => {
      tx.update(terminalSession)
        .set({ status: "exited", exitCode, endedAt })
        .where(and(eq(terminalSession.id, id), inArray(terminalSession.status, LIVE)))
        .run();
      return endAgentSessionsIn(tx, id, endedAt);
    });
    publish({ type: "terminalSession", id });
    for (const sessionId of agentSessionIds) publish({ type: "agentSession", sessionId });
    client?.notify({ op: "reap", session_id: id });
    respawnInBackground([id]);
  }

  // 張り直すかは待った後の transaction の中で決めるので、間に Tab が閉じられたり手で張り直されたりしても二重に起こさない。
  // id を省くと pin された Tab をすべて見る。Exit の記録と張り直しの間で Backend が止まった分も拾うため。
  async function respawnPinnedTabs(endedIds?: string[]) {
    await ready();
    const respawned = db.transaction((tx) =>
      tx
        .select()
        .from(terminalSession)
        .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
        .where(endedIds ? inArray(terminalSession.id, endedIds) : eq(tab.pinned, true))
        .all()
        .flatMap((row) =>
          row.tab && shouldRespawn(row.terminal_session, row.tab)
            ? [bindNewTerminalSession(tx, row.tab, shell).terminalSessionId]
            : [],
        ),
    );
    if (respawned.length === 0) return;
    publish({ type: "layout" });
    await Promise.all(respawned.map((id) => startTerminalSession(workbench, id, RESPAWN_SIZE)));
  }

  function respawnInBackground(endedIds?: string[]) {
    respawnPinnedTabs(endedIds).catch((error: unknown) => {
      if (!stopping) console.error(`[workbench] respawning pinned Tabs failed: ${error}`);
    });
  }

  // 繋ぎ直すのは reconcile まで済んだ接続が切れたときだけ。hello や List の途中で切れたら、
  // その connect を回している reconnect が retry するので、ここで 2 本目のループを始めない。
  function onClose() {
    const wasConnected = client !== null;
    client = null;
    if (stopping || !wasConnected) return;
    console.error("[workbench] lost tania-ptyd; reconnecting");
    connection = reconnect();
    // 待つ呼び手が居ないまま stop() で reject しても unhandled にしない。
    connection.catch(() => {});
  }

  async function connect(): Promise<PtydClient> {
    if (stopping) throw new Error("the Workbench has stopped");
    exitsDuringReconcile = [];
    try {
      const opened = await openDaemon({ home, ptydPath }, { onExit, onClose });
      if (stopping) {
        opened.close();
        throw new Error("the Workbench has stopped");
      }
      const { reap, terminate, agentSessionIds } = reconcile(db, await opened.list(), {
        backendRestarted,
      });
      backendRestarted = false;
      for (const id of reap) opened.notify({ op: "reap", session_id: id });
      for (const id of terminate) opened.notify({ op: "terminate", session_id: id });
      client = opened;
      const exits = exitsDuringReconcile;
      exitsDuringReconcile = null;
      for (const [id, exitCode] of exits) onExit(id, exitCode);
      for (const sessionId of agentSessionIds) publish({ type: "agentSession", sessionId });
      publish({ type: "reconciled" });
      respawnInBackground();
      console.error(
        `[workbench] connected to tania-ptyd; reaped ${reap.length}, terminated ${terminate.length}`,
      );
      return opened;
    } finally {
      exitsDuringReconcile = null;
    }
  }

  async function reconnect(): Promise<PtydClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await connect();
      } catch (error) {
        if (stopping) throw error;
        console.error(`[workbench] tania-ptyd connection failed: ${error}`);
        await Bun.sleep(Math.min(5000, 200 * 2 ** attempt));
      }
    }
  }

  // ptyd を使う呼び出しはすべて reconcile の完了を待つ。起動時の List と競う Create を、
  // ptyd が失った行と取り違えないため。
  function ready(): Promise<PtydClient> {
    connection ??= reconnect();
    return connection;
  }

  const workbench: Workbench = {
    events,
    async start() {
      try {
        writeTabFiles(home);
      } catch (error) {
        console.error(`[workbench] could not write the Tab's shell files: ${error}`);
      }
      await ready();
    },
    stop() {
      stopping = true;
      client?.close();
    },
    async ready() {
      await ready();
    },
    createRunspace(tx, { cwd }) {
      const id = createRunspace(tx, { cwd, owned: true });
      publish({ type: "layout" });
      return id;
    },
    openTab(tx, input) {
      const opened = openTab(tx, { ...input, shell });
      publish({ type: "layout" });
      return { tabId: opened.id, terminalSessionId: opened.terminalSessionId };
    },
    moveTab(tx, tabId, runspaceId) {
      moveTab(tx, { id: tabId, runspaceId });
      publish({ type: "layout" });
    },
    removeRunspace(tx, id, options) {
      const removed = removeRunspace(tx, id, options);
      publish({ type: "layout" });
      return removed;
    },
    startTerminalSession: (id, size) => startTerminalSession(workbench, id, size),
    // ptyd は attach していない接続からの Write も通すので、webview が Tab を表示していなくても打てる。
    async writeTerminalSession(id, data) {
      const ptyd = await ready();
      await ptyd.request({
        op: "write",
        session_id: id,
        data: Buffer.from(data).toString("base64"),
      });
    },
    terminateTerminalSessions: (ids) => terminateTerminalSessions(workbench, ids),
  };
  internalsOf.set(workbench, { db, home, shell, publish, ready, notify, nameAgentSession });
  return workbench;
}

// 通知は commit した後の副作用なので、出せなくても hook の記録と変更の合図は止めない。
export function notifyWaiting(workbench: Workbench, agentSession: AgentSession, body: string) {
  const { db, notify, nameAgentSession } = internals(workbench);
  try {
    const title = nameAgentSession(db, agentSession.sessionId) ?? shortPath(agentSession.cwd);
    notify({ title, body });
  } catch (error) {
    console.error(`[workbench] could not notify for ${agentSession.sessionId}: ${error}`);
  }
}

// reconcile より先に書いた starting の行は lost にされるので、行に書く shell は reconcile を待ってから渡す。
export async function shellWhenReady(workbench: Workbench): Promise<string> {
  const { shell, ready } = internals(workbench);
  await ready();
  return shell;
}

export function insertTerminalSession(tx: Tx, { cwd, shell }: { cwd: string; shell: string }) {
  const id = `ts-${Bun.randomUUIDv7()}`;
  tx.insert(terminalSession)
    .values({ id, cwd, shell, status: "starting", createdAt: new Date() })
    .run();
  return id;
}

export function bindNewTerminalSession(tx: Tx, target: { id: string; cwd: string }, shell: string) {
  return tx
    .update(tab)
    .set({ terminalSessionId: insertTerminalSession(tx, { cwd: target.cwd, shell }) })
    .where(eq(tab.id, target.id))
    .returning()
    .get()!;
}

export async function startTerminalSession(workbench: Workbench, id: string, { rows, cols }: Size) {
  const { db, home, publish, ready } = internals(workbench);
  const ptyd = await ready();
  const { cwd, shell } = db.select().from(terminalSession).where(eq(terminalSession.id, id)).get()!;
  // 即死した shell の Exit は Created の応答より先に届くことがあるので、starting の行だけを進める。
  const stillStarting = and(eq(terminalSession.id, id), eq(terminalSession.status, "starting"));
  try {
    const env = tabEnv(home, id);
    const pid = await ptyd.create({ session_id: id, cwd, shell, rows, cols, env });
    db.update(terminalSession).set({ status: "running", pid }).where(stillStarting).run();
  } catch (error) {
    // 接続が切れただけなら ptyd が作ったかは分からないので、starting のまま繋ぎ直した後の reconcile に決めさせる。
    if (ptyd.isClosed()) return;
    db.update(terminalSession)
      .set({ status: "failed", error: String(error), endedAt: new Date() })
      .where(stillStarting)
      .run();
  }
  publish({ type: "terminalSession", id });
}

// 呼び手は Tab を消して commit した後なので、送る途中で接続が切れても繋ぎ直した ptyd に送り直す（Terminate は冪等）。
export async function terminateTerminalSessions(workbench: Workbench, ids: string[]) {
  const { ready } = internals(workbench);
  await Promise.all(
    ids.map(async (id) => {
      for (;;) {
        const ptyd = await ready();
        try {
          await ptyd.request({ op: "terminate", session_id: id });
          return;
        } catch (error) {
          if (!ptyd.isClosed()) throw error;
        }
      }
    }),
  );
}

function reconcile(
  db: Db,
  ptydSessions: SessionInfo[],
  { backendRestarted }: { backendRestarted: boolean },
) {
  const now = new Date();
  const unmatched = new Map(ptydSessions.map((s) => [s.session_id, s]));
  const reap: string[] = [];
  const terminate: string[] = [];
  const agentSessionIds = db.transaction((tx) => {
    for (const row of tx.select().from(terminalSession).all()) {
      const held = unmatched.get(row.id);
      unmatched.delete(row.id);
      if (!isLive(row.status)) {
        // 終わった行は生き返らないので、同じ id で ptyd に残るものはどこからも辿れない。
        if (held?.running) terminate.push(row.id);
        else if (held) reap.push(row.id);
        continue;
      }
      if (!held) {
        tx.update(terminalSession)
          .set({ status: "lost", endedAt: now })
          .where(eq(terminalSession.id, row.id))
          .run();
        continue;
      }
      if (!held.running) {
        tx.update(terminalSession)
          .set({ status: "exited", exitCode: held.exit_code, endedAt: now })
          .where(eq(terminalSession.id, row.id))
          .run();
        reap.push(row.id);
        continue;
      }
      tx.update(terminalSession)
        .set({ status: "running", pid: held.pid })
        .where(eq(terminalSession.id, row.id))
        .run();
    }
    // DB を消した後や Create と INSERT の間の crash で、ptyd にだけ残った session。
    for (const held of unmatched.values()) {
      if (!held.running) {
        reap.push(held.session_id);
        continue;
      }
      tx.insert(terminalSession)
        .values({
          id: held.session_id,
          cwd: held.cwd,
          shell: "",
          status: "running",
          pid: held.pid,
          createdAt: now,
        })
        .run();
    }
    return reconcileAgentSessions(tx, { backendRestarted });
  });
  return { reap, terminate, agentSessionIds };
}

export function isLive(status: TerminalSession["status"]): boolean {
  return (LIVE as readonly string[]).includes(status);
}
