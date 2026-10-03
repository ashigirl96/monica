import { eventIterator, oc } from "@orpc/contract";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";
import { issue } from "./schema.ts";

const meta = oc.$meta<{ description?: string; cli?: boolean }>({});
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } });

const IssueStateSchema = createSelectSchema(issue).shape.state;

export const DisplayStateSchema = z.object({
  state: z.enum(["closed", "issue_closed", "not_started"]),
});

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

export type TrackOutput = z.infer<typeof TrackOutputSchema>;
export type SyncOutput = z.infer<typeof SyncOutputSchema>;
export type ListOutput = z.infer<typeof ListOutputSchema>;

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
  changes: meta
    .meta({ description: "Stream signals that Tasks or their Issue copies changed" })
    .output(eventIterator(TaskChangeSchema)),
};
