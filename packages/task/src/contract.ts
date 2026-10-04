import { eventIterator, oc } from "@orpc/contract";
import { AgentSessionSchema } from "@tania/workbench/contract";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";
import { bench, issue } from "./schema.ts";

const meta = oc.$meta<{ description?: string; cli?: boolean }>({});
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } });

const IssueStateSchema = createSelectSchema(issue).shape.state;
const BenchSchema = createSelectSchema(bench);
const WaitReasonSchema = AgentSessionSchema.shape.waitReason.unwrap();
const LiveStateSchema = AgentSessionSchema.shape.state.exclude(["ended"]);

export const LiveRunSchema = z.object({
  agentSessionId: z.string(),
  state: LiveStateSchema,
  reason: WaitReasonSchema.optional(),
  since: z.date(),
});

const liveRuns = z
  .array(LiveRunSchema)
  .describe("the live Runs, the one the state comes from first");

export const DisplayStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["closed", "issue_closed", "not_started", "preparing", "setup_failed", "ended"]),
  }),
  z.object({
    state: z.literal("waiting"),
    reason: WaitReasonSchema,
    tool: z.string().optional(),
    errorType: z.string().optional(),
    since: z.date(),
    liveRuns,
  }),
  z.object({ state: LiveStateSchema.exclude(["waiting"]), since: z.date(), liveRuns }),
]);

export const ListItemSchema = z.object({
  ref: z.string(),
  title: z.string(),
  issueState: IssueStateSchema,
  blockers: z.array(z.string()).describe("refs of the open Blockers"),
  cwd: z.string().nullable(),
  displayState: DisplayStateSchema,
});

export const BackgroundSyncErrorSchema = z.object({ at: z.date(), message: z.string() });

// 合図だけを流す。購読側は payload を信じず読み直す。
export const TaskChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), ref: z.string() }),
  z.object({ type: z.literal("synced") }),
]);

export type DisplayState = z.infer<typeof DisplayStateSchema>;
export type LiveRun = z.infer<typeof LiveRunSchema>;
export type ListItem = z.infer<typeof ListItemSchema>;
export type TaskChange = z.infer<typeof TaskChangeSchema>;
export type BackgroundSyncError = z.infer<typeof BackgroundSyncErrorSchema>;

const ref = z.string().meta({
  positional: true,
  description: "owner/repo#n or https://github.com/owner/repo/issues/n",
});

export const TrackOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  alreadyTracked: z.boolean(),
  closed: z.boolean(),
});

export const SyncOutputSchema = z.object({
  synced: z.number().int().nonnegative(),
  missing: z.array(z.string()).describe("refs GitHub did not return; their copies are kept"),
});

export const ListOutputSchema = z.object({
  tasks: z.array(ListItemSchema),
  backgroundSyncError: BackgroundSyncErrorSchema.nullable(),
});

export const RunOutputSchema = z.object({
  ref: z.string(),
  cwd: z.string(),
  mode: BenchSchema.shape.mode,
  benchCreated: z.boolean(),
  warnings: z.array(z.string()),
});

export const CurrentOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  displayState: DisplayStateSchema,
  agentSessionId: z.string().nullable(),
  source: z.enum(["run", "bench"]),
});

export const BenchItemSchema = z.object({
  runspaceId: z.string(),
  ref: z.string(),
  title: z.string(),
  setupState: BenchSchema.shape.setupState,
});

export type TrackOutput = z.infer<typeof TrackOutputSchema>;
export type SyncOutput = z.infer<typeof SyncOutputSchema>;
export type ListOutput = z.infer<typeof ListOutputSchema>;
export type RunOutput = z.infer<typeof RunOutputSchema>;
export type CurrentOutput = z.infer<typeof CurrentOutputSchema>;
export type BenchItem = z.infer<typeof BenchItemSchema>;

export const contract = {
  track: meta
    .meta({
      description:
        "Track a GitHub Issue as a Task and copy it with its parent and Blockers; a tracked one is synced",
      cli: true,
    })
    .input(z.object({ ref }))
    .output(TrackOutputSchema),
  sync: meta
    .meta({
      description: "Copy the Issues of every open Task, or of one Task given its ref, from GitHub",
      cli: true,
    })
    .input(z.object({ ref: ref.optional() }))
    .output(SyncOutputSchema),
  list: meta
    .meta({ description: "List open Tasks in the order they were tracked", cli: true })
    .input(z.object({ closed: z.boolean().optional().describe("list closed Tasks instead") }))
    .output(ListOutputSchema),
  run: meta
    .meta({
      description:
        "Open the Bench of an open Task, preparing its worktree and setup, and print its cwd once it is ready",
      cli: true,
    })
    .input(
      z.object({
        ref,
        inPlace: z
          .boolean()
          .optional()
          .describe("use the Repo's checkout as the cwd, with no worktree and no setup"),
      }),
    )
    .output(RunOutputSchema),
  current: meta
    .meta({ description: "Show the Task of the Tab this runs in", cli: true })
    .input(z.object({ terminalSessionId: z.string().optional() }))
    .output(CurrentOutputSchema),
  bench: {
    list: meta
      .meta({ description: "List the Benches with the labels of their Tasks" })
      .output(z.array(BenchItemSchema)),
  },
  changes: meta
    .meta({
      description:
        "Stream signals that Tasks, their Issue copies, their Benches or the Agent Sessions of their Runs changed",
    })
    .output(eventIterator(TaskChangeSchema)),
};
