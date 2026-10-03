import { homedir } from "node:os";
import { implement, ORPCError } from "@orpc/server";
import { eq, getTableColumns, inArray, isNotNull, or } from "drizzle-orm";
import { contract } from "./contract.ts";
import {
  asTab,
  closeTab,
  createRunspace,
  moveRunspace,
  moveTab,
  openTab,
  readLayout,
  reattachTab,
  removeRunspace,
  respawnTab,
  setTabCwd,
  writeLayout,
} from "./layout.ts";
import { tab, terminalSession } from "./schema.ts";
import {
  type Db,
  LIVE,
  shellWhenReady,
  startTerminalSession,
  terminateTerminalSessions,
  type Workbench,
} from "./workbench.ts";

export { migrations } from "../migrations/index.ts";
export { createWorkbench, type Db, type Workbench } from "./workbench.ts";

const os = implement(contract).$context<{ db: Db; workbench: Workbench }>();

export const router = os.router({
  terminalSession: {
    list: os.terminalSession.list.handler(({ context }) =>
      context.db
        .select({ ...getTableColumns(terminalSession), tabId: tab.id })
        .from(terminalSession)
        .leftJoin(tab, eq(tab.terminalSessionId, terminalSession.id))
        .where(or(inArray(terminalSession.status, LIVE), isNotNull(tab.id)))
        .orderBy(terminalSession.createdAt)
        .all(),
    ),
    terminate: os.terminalSession.terminate.handler(async ({ context, input }) => {
      const row = context.db
        .select({ id: terminalSession.id })
        .from(terminalSession)
        .where(eq(terminalSession.id, input.id))
        .get();
      if (!row) throw new ORPCError("NOT_FOUND", { message: `no Terminal Session ${input.id}` });
      await terminateTerminalSessions(context.workbench, [input.id]);
    }),
  },
  layout: {
    get: os.layout.get.handler(({ context }) => readLayout(context.db)),
  },
  runspace: {
    create: os.runspace.create.handler(async ({ context, input }) => {
      const cwd = input.cwd ?? homedir();
      const shell = await shellWhenReady(context.workbench);
      const opened = writeLayout(context, (tx) =>
        openTab(tx, { runspaceId: createRunspace(tx, { cwd, index: input.index }), cwd, shell }),
      );
      await startTerminalSession(context.workbench, opened.terminalSessionId, input);
      return { runspaceId: opened.runspaceId, tab: asTab(opened) };
    }),
    remove: os.runspace.remove.handler(async ({ context, input }) => {
      const terminalSessionIds = writeLayout(context, (tx) => removeRunspace(tx, input.id));
      await terminateTerminalSessions(context.workbench, terminalSessionIds);
    }),
    move: os.runspace.move.handler(({ context, input }) => {
      writeLayout(context, (tx) => moveRunspace(tx, input));
    }),
  },
  tab: {
    open: os.tab.open.handler(async ({ context, input }) => {
      const { runspaceId, cwd, index, terminalSessionId } = input;
      if (terminalSessionId) {
        return asTab(
          writeLayout(context, (tx) =>
            reattachTab(tx, { runspaceId, cwd, index, terminalSessionId }),
          ),
        );
      }
      const shell = await shellWhenReady(context.workbench);
      const opened = writeLayout(context, (tx) => openTab(tx, { runspaceId, cwd, index, shell }));
      await startTerminalSession(context.workbench, opened.terminalSessionId, input);
      return asTab(opened);
    }),
    respawn: os.tab.respawn.handler(async ({ context, input }) =>
      asTab(await respawnTab(context, input.id, input)),
    ),
    close: os.tab.close.handler(({ context, input }) => {
      writeLayout(context, (tx) => closeTab(tx, input.id));
    }),
    move: os.tab.move.handler(({ context, input }) => {
      writeLayout(context, (tx) => moveTab(tx, input));
    }),
    setCwd: os.tab.setCwd.handler(({ context, input }) => {
      writeLayout(context, (tx) => setTabCwd(tx, input));
    }),
  },
  changes: os.changes.handler(async function* ({ context, signal }) {
    for await (const change of context.workbench.events.subscribe("change", { signal })) {
      yield change;
    }
  }),
});
