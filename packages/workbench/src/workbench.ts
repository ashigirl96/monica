import { userInfo } from "node:os";
import { EventPublisher } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { TerminalSession, WorkbenchChange } from "./contract.ts";
import { openDaemon, type PtydClient, type SessionInfo } from "./ptyd.ts";
import { terminalSession } from "./schema.ts";

export type Db = BunSQLiteDatabase;

export const LIVE = ["starting", "running"] as const;

export type Workbench = {
  events: EventPublisher<{ change: WorkbenchChange }>;
  start(): Promise<void>;
  stop(): void;
};

type Internals = {
  db: Db;
  shell: string;
  publish: (change: WorkbenchChange) => void;
  ready: () => Promise<PtydClient>;
};

// Workbench の型は events / start / stop だけに保ち、ptyd の接続などの中身は Workbench を key にここへ置く。
const internalsOf = new WeakMap<Workbench, Internals>();

function internals(workbench: Workbench): Internals {
  const found = internalsOf.get(workbench);
  if (!found) throw new Error("this Workbench was not made by createWorkbench");
  return found;
}

export function createWorkbench(deps: {
  db: Db;
  home: string;
  ptydPath: string;
  notify: (n: { title: string; body: string }) => void;
  nameAgentSession: (db: Db, agentSessionId: string) => string | null;
}): Workbench {
  const { db, home, ptydPath } = deps;
  const events = new EventPublisher<{ change: WorkbenchChange }>();
  const publish = (change: WorkbenchChange) => events.publish("change", change);
  const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";

  let client: PtydClient | null = null;
  let connection: Promise<PtydClient> | null = null;
  let stopping = false;

  // Reap は commit の後にする。間で Backend が死んでも tombstone が残り、次の reconcile が拾う。
  function onExit(id: string, exitCode: number | null) {
    db.update(terminalSession)
      .set({ status: "exited", exitCode, endedAt: new Date() })
      .where(and(eq(terminalSession.id, id), inArray(terminalSession.status, LIVE)))
      .run();
    publish({ type: "terminalSession", id });
    client?.notify({ op: "reap", session_id: id });
  }

  function onClose() {
    client = null;
    if (stopping) return;
    console.error("[workbench] lost tania-ptyd; reconnecting");
    connection = reconnect();
    // 待つ呼び手が居ないまま stop() で reject しても unhandled にしない。
    connection.catch(() => {});
  }

  async function connect(): Promise<PtydClient> {
    if (stopping) throw new Error("the Workbench has stopped");
    const opened = await openDaemon({ home, ptydPath }, { onExit, onClose });
    if (stopping) {
      opened.close();
      throw new Error("the Workbench has stopped");
    }
    const { reap, terminate } = reconcile(db, await opened.list());
    for (const id of reap) opened.notify({ op: "reap", session_id: id });
    for (const id of terminate) opened.notify({ op: "terminate", session_id: id });
    client = opened;
    publish({ type: "reconciled" });
    console.error(
      `[workbench] connected to tania-ptyd; reaped ${reap.length}, terminated ${terminate.length}`,
    );
    return opened;
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
    start: () => ready().then(() => {}),
    stop() {
      stopping = true;
      client?.close();
    },
  };
  internalsOf.set(workbench, { db, shell, publish, ready });
  return workbench;
}

export async function createTerminalSession(
  workbench: Workbench,
  input: { cwd: string; rows: number; cols: number },
): Promise<TerminalSession> {
  const { db, shell, publish, ready } = internals(workbench);
  const ptyd = await ready();
  const id = `ts-${Bun.randomUUIDv7()}`;
  db.insert(terminalSession)
    .values({ id, cwd: input.cwd, shell, status: "starting", createdAt: new Date() })
    .run();
  // 即死した shell の Exit は Created の応答より先に届くことがあるので、starting の行だけを進める。
  const stillStarting = and(eq(terminalSession.id, id), eq(terminalSession.status, "starting"));
  try {
    const pid = await ptyd.create({
      session_id: id,
      cwd: input.cwd,
      shell,
      rows: input.rows,
      cols: input.cols,
      env: null,
    });
    db.update(terminalSession).set({ status: "running", pid }).where(stillStarting).run();
  } catch (error) {
    db.update(terminalSession)
      .set({ status: "failed", error: String(error), endedAt: new Date() })
      .where(stillStarting)
      .run();
  }
  publish({ type: "terminalSession", id });
  return db.select().from(terminalSession).where(eq(terminalSession.id, id)).get()!;
}

export async function terminateTerminalSession(workbench: Workbench, id: string) {
  const ptyd = await internals(workbench).ready();
  await ptyd.request({ op: "terminate", session_id: id });
}

function reconcile(db: Db, ptydSessions: SessionInfo[]) {
  const now = new Date();
  const unmatched = new Map(ptydSessions.map((s) => [s.session_id, s]));
  const reap: string[] = [];
  const terminate: string[] = [];
  db.transaction((tx) => {
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
  });
  return { reap, terminate };
}

function isLive(status: TerminalSession["status"]): boolean {
  return (LIVE as readonly string[]).includes(status);
}
