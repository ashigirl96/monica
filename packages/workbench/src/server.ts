import { implement, ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { contract } from "./contract.ts";
import { terminalSession } from "./schema.ts";
import { type Db, LIVE, terminateTerminalSession, type Workbench } from "./workbench.ts";

export { migrations } from "../migrations/index.ts";
export { createWorkbench, type Db, type Workbench } from "./workbench.ts";

const os = implement(contract).$context<{ db: Db; workbench: Workbench }>();

export const router = os.router({
  terminalSession: {
    list: os.terminalSession.list.handler(({ context }) =>
      context.db
        .select()
        .from(terminalSession)
        .where(inArray(terminalSession.status, LIVE))
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
      await terminateTerminalSession(context.workbench, input.id);
    }),
  },
  changes: os.changes.handler(async function* ({ context, signal }) {
    for await (const change of context.workbench.events.subscribe("change", { signal })) {
      yield change;
    }
  }),
});
