import { eventIterator, oc } from "@orpc/contract";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";
import { terminalSession } from "./schema.ts";

const meta = oc.$meta<{ description?: string; cli?: boolean }>({});
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } });

export const TerminalSessionSchema = createSelectSchema(terminalSession);

// 合図だけを流す。購読側は payload を信じず読み直す。
export const WorkbenchChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminalSession"), id: z.string() }),
  z.object({ type: z.literal("reconciled") }),
]);

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type WorkbenchChange = z.infer<typeof WorkbenchChangeSchema>;

export const contract = {
  terminalSession: {
    list: meta
      .meta({ description: "List live Terminal Sessions", cli: true })
      .output(z.array(TerminalSessionSchema)),
    terminate: meta
      .meta({
        description: "Kill a Terminal Session; its row turns exited when ptyd reports the exit",
      })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
  },
  changes: meta
    .meta({ description: "Stream signals that the Workbench books changed" })
    .output(eventIterator(WorkbenchChangeSchema)),
};
