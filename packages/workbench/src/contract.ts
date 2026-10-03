import { eventIterator, oc } from "@orpc/contract";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";
import { agentSession, runspace, tab, terminalSession } from "./schema.ts";

const meta = oc.$meta<{ description?: string; cli?: boolean }>({});
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } });

export const TerminalSessionSchema = createSelectSchema(terminalSession).extend({
  tabId: z.string().nullable(),
});

export const TabSchema = createSelectSchema(tab).omit({ runspaceId: true });

export const LayoutSchema = z.object({
  runspaces: z.array(createSelectSchema(runspace).extend({ tabs: z.array(TabSchema) })),
});

export const AgentSessionSchema = createSelectSchema(agentSession);

// 合図だけを流す。購読側は payload を信じず読み直す。
export const WorkbenchChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("layout") }),
  z.object({ type: z.literal("terminalSession"), id: z.string() }),
  z.object({ type: z.literal("agentSession"), sessionId: z.string() }),
  z.object({ type: z.literal("reconciled") }),
]);

export const WorktreeSchema = z.object({ repo: z.string(), branch: z.string() });

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type Tab = z.infer<typeof TabSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type WorkbenchChange = z.infer<typeof WorkbenchChangeSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;

const size = { rows: z.number().int().positive(), cols: z.number().int().positive() };
const index = z.number().int().nonnegative();

export const contract = {
  terminalSession: {
    list: meta
      .meta({ description: "List Terminal Sessions that are live or shown in a Tab", cli: true })
      .output(z.array(TerminalSessionSchema)),
    terminate: meta
      .meta({
        description: "Kill a Terminal Session; its row turns exited when ptyd reports the exit",
      })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
  },
  layout: {
    get: meta
      .meta({ description: "Read the Runspaces and their Tabs in order" })
      .output(LayoutSchema),
  },
  runspace: {
    create: meta
      .meta({ description: "Open a Runspace with one Tab on a new Terminal Session" })
      .input(z.object({ cwd: z.string().optional(), index: index.optional(), ...size }))
      .output(z.object({ runspaceId: z.string(), tab: TabSchema })),
    remove: meta
      .meta({
        description: "Remove a Runspace with its Tabs and terminate their Terminal Sessions",
      })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
    move: meta
      .meta({ description: "Move a Runspace to a position in the sidebar" })
      .input(z.object({ id: z.string(), index }))
      .output(z.void()),
  },
  tab: {
    open: meta
      .meta({
        description:
          "Open a Tab on a new Terminal Session, or on a detached one given its id to reattach it",
      })
      .input(
        z.object({
          runspaceId: z.string(),
          cwd: z.string().optional(),
          index: index.optional(),
          ...size,
          terminalSessionId: z.string().optional(),
        }),
      )
      .output(TabSchema),
    respawn: meta
      .meta({
        description: "Bind a Tab whose Terminal Session has ended to a new one in the Tab's cwd",
      })
      .input(z.object({ id: z.string(), ...size }))
      .output(TabSchema),
    close: meta
      .meta({ description: "Close a Tab, leaving its Terminal Session detached" })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
    move: meta
      .meta({ description: "Move a Tab to a position in a Runspace" })
      .input(z.object({ id: z.string(), runspaceId: z.string(), index }))
      .output(z.void()),
    setCwd: meta
      .meta({ description: "Record the last known cwd of a Tab" })
      .input(z.object({ id: z.string(), cwd: z.string() }))
      .output(z.void()),
    pin: meta
      .meta({
        description:
          "Pin a Tab, moving the pin from another Tab of its Runspace or splitting it into a new Runspace",
      })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
    unpin: meta
      .meta({ description: "Unpin a Tab, leaving it in its Runspace" })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
  },
  agentSession: {
    recordHook: meta
      .meta({ description: "Apply a Claude Code hook from a Tab to its Agent Session" })
      .input(
        z.object({ terminalSessionId: z.string(), payload: z.record(z.string(), z.unknown()) }),
      )
      .output(z.void()),
    list: meta
      .meta({ description: "List Agent Sessions that have not ended", cli: true })
      .output(z.array(AgentSessionSchema)),
  },
  worktree: {
    info: meta
      .meta({
        description: "Name the repo and branch of the linked worktree a directory is in, if any",
      })
      .input(z.object({ cwd: z.string() }))
      .output(WorktreeSchema.nullable()),
  },
  editor: {
    resolve: meta
      .meta({
        description:
          "Resolve paths printed in a terminal to existing files, or null where none exists",
      })
      .input(z.object({ cwd: z.string(), candidates: z.array(z.string()) }))
      .output(z.array(z.string().nullable())),
    open: meta
      .meta({ description: "Open a file in Zed" })
      .input(z.object({ path: z.string() }))
      .output(z.void()),
  },
  changes: meta
    .meta({ description: "Stream signals that the Workbench books changed" })
    .output(eventIterator(WorkbenchChangeSchema)),
};
