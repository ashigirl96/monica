import { AgentSessionSchema } from '@monica/workbench/contract'
import { eventIterator, oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { bench, issue } from './schema.ts'

const meta = oc.$meta<{ description?: string; cli?: boolean }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

const IssueStateSchema = createSelectSchema(issue).shape.state
const BenchSchema = createSelectSchema(bench)
const WaitReasonSchema = AgentSessionSchema.shape.waitReason.unwrap()
const LiveStateSchema = AgentSessionSchema.shape.state.exclude(['ended'])

export const LiveRunSchema = z.object({
  agentSessionId: z.string(),
  state: LiveStateSchema,
  reason: WaitReasonSchema.optional(),
  since: z.date(),
})

const liveRuns = z
  .array(LiveRunSchema)
  .describe('the live Runs, the one the state comes from first')

export const DisplayStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['closed', 'issue_closed', 'not_started', 'preparing', 'setup_failed', 'ended']),
  }),
  z.object({
    state: z.literal('waiting'),
    reason: WaitReasonSchema,
    tool: z.string().optional(),
    errorType: z.string().optional(),
    since: z.date(),
    liveRuns,
  }),
  z.object({ state: LiveStateSchema.exclude(['waiting']), since: z.date(), liveRuns }),
])

export const ListItemSchema = z.object({
  ref: z.string(),
  title: z.string(),
  issueState: IssueStateSchema,
  blockers: z.array(z.string()).describe('refs of the open Blockers'),
  cwd: z.string().nullable(),
  displayState: DisplayStateSchema,
})

export const BackgroundSyncErrorSchema = z.object({ at: z.date(), message: z.string() })

// 合図だけを流す。購読側は payload を信じず読み直す。
export const TaskChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task'), ref: z.string() }),
  z.object({ type: z.literal('synced') }),
])

export type DisplayState = z.infer<typeof DisplayStateSchema>
export type LiveRun = z.infer<typeof LiveRunSchema>
export type ListItem = z.infer<typeof ListItemSchema>
export type TaskChange = z.infer<typeof TaskChangeSchema>
export type BackgroundSyncError = z.infer<typeof BackgroundSyncErrorSchema>

const ref = z.string().meta({
  positional: true,
  description: 'owner/repo#n or https://github.com/owner/repo/issues/n',
})

export const TrackOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  alreadyTracked: z.boolean(),
  closed: z.boolean(),
})

export const SyncOutputSchema = z.object({
  synced: z.number().int().nonnegative(),
  missing: z.array(z.string()).describe('refs GitHub did not return; their copies are kept'),
})

export const ListOutputSchema = z.object({
  tasks: z.array(ListItemSchema),
  backgroundSyncError: BackgroundSyncErrorSchema.nullable(),
})

export const RunOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  tracked: z.boolean().describe('whether this run tracked the Issue'),
  cwd: z.string().describe('the cwd of the Bench'),
  mode: BenchSchema.shape.mode,
  benchCreated: z.boolean(),
  warnings: z.array(z.string()),
  tabId: z.string(),
  terminalSessionId: z.string(),
  resumed: z.string().nullable().describe('the Agent Session resumed, or null for a new claude'),
})

export const runErrors = {
  BLOCKED: {
    status: 409,
    message: 'the Issue of the Task has open Blockers',
    data: z.object({ blockers: z.array(z.string()).describe('refs of the open Blockers') }),
  },
}

export const PromptKindSchema = z
  .enum(['tackle', 'implement-spec', 'triage', 'wayfinder'])
  .describe(
    'what the Run is started with; tackle leaves the prompt out for /tackle, implement-spec sends /implement-spec #<n> for an Issue with open sub-issues, triage sends /triage #<n>, and wayfinder sends /wayfinder <n> for a map or /wayfinder <map> <n> for an Issue under one',
  )

export const RunButtonSchema = z.object({
  kind: PromptKindSchema,
  run: z
    .enum(['new', 'resume', 'running'])
    .describe(
      'new starts a Run, resume resumes the ended one sending no prompt, running is a live Run and cannot be pressed',
    ),
})

export const RunButtonsOutputSchema = z.object({
  buttons: z.array(
    z.object({
      ref: z.string().describe('the ref as asked'),
      button: RunButtonSchema.nullable().describe('null when the Issue gets no Run button'),
    }),
  ),
})

export const CurrentOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  displayState: DisplayStateSchema,
  agentSessionId: z.string().nullable(),
  source: z.enum(['run', 'bench']),
})

export const AttachOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  benchCreated: z.boolean().describe('whether the Bench was opened in place to take the Tab'),
  runCreated: z.boolean(),
  agentSessionId: z
    .string()
    .nullable()
    .describe('the live Agent Session of the Tab, or null when no agent runs in it'),
})

export const CloseRefusalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active_run'), agentSessionId: z.string(), state: LiveStateSchema }),
  z.object({ kind: z.literal('uncommitted_changes'), worktree: z.string() }),
  z.object({ kind: z.literal('unpublished_commits'), branch: z.string() }),
])

export const closeErrors = {
  CLOSE_REFUSED: {
    status: 409,
    message: 'the Task has live Runs or work closing would lose',
    data: z.object({ reasons: z.array(CloseRefusalSchema) }),
  },
}

export const CloseOutputSchema = z.object({
  ref: z.string(),
  removedWorktree: z.string().nullable().describe('the worktree removed, or null for none'),
  deletedBranch: z.string().nullable().describe('the branch deleted, or null for none'),
  spared: z
    .boolean()
    .describe('whether the Tab this runs in stayed, in a Runspace no longer the Bench'),
  warnings: z.array(z.string()),
})

export const ReopenOutputSchema = z.object({
  ref: z.string(),
  title: z.string(),
  warnings: z.array(z.string()),
})

export const BenchItemSchema = z.object({
  runspaceId: z.string(),
  ref: z.string(),
  title: z.string(),
  setupState: BenchSchema.shape.setupState,
})

export type TrackOutput = z.infer<typeof TrackOutputSchema>
export type SyncOutput = z.infer<typeof SyncOutputSchema>
export type ListOutput = z.infer<typeof ListOutputSchema>
export type RunOutput = z.infer<typeof RunOutputSchema>
export type PromptKind = z.infer<typeof PromptKindSchema>
export type RunButton = z.infer<typeof RunButtonSchema>
export type RunButtonsOutput = z.infer<typeof RunButtonsOutputSchema>
export type CurrentOutput = z.infer<typeof CurrentOutputSchema>
export type AttachOutput = z.infer<typeof AttachOutputSchema>
export type CloseRefusal = z.infer<typeof CloseRefusalSchema>
export type CloseOutput = z.infer<typeof CloseOutputSchema>
export type ReopenOutput = z.infer<typeof ReopenOutputSchema>
export type BenchItem = z.infer<typeof BenchItemSchema>

export const contract = {
  track: meta
    .meta({
      description:
        'Track a GitHub Issue as a Task and copy it with its parent and Blockers; a tracked one is synced',
      cli: true,
    })
    .input(z.object({ ref }))
    .output(TrackOutputSchema),
  sync: meta
    .meta({
      description: 'Copy the Issues of every open Task, or of one Task given its ref, from GitHub',
      cli: true,
    })
    .input(z.object({ ref: ref.optional() }))
    .output(SyncOutputSchema),
  list: meta
    .meta({ description: 'List open Tasks in the order they were tracked', cli: true })
    .input(z.object({ closed: z.boolean().optional().describe('list closed Tasks instead') }))
    .output(ListOutputSchema),
  run: meta
    .meta({
      description:
        'Start claude with a first prompt (/tackle if left out) in a new Tab of the Bench of an open Task, tracking the Issue and opening and preparing the Bench first, or resume the last claude of the Bench once it has ended',
      cli: true,
    })
    .errors(runErrors)
    .input(
      z.object({
        ref,
        prompt: z
          .string()
          .meta({
            positional: true,
            description: 'the first prompt to claude; /tackle if left out, and nothing on a resume',
          })
          .optional(),
        inPlace: z
          .boolean()
          .optional()
          .describe("use the Repo's checkout as the cwd, with no worktree and no setup"),
        force: z
          .boolean()
          .optional()
          .describe('start a new Run even when the Issue has open Blockers'),
      }),
    )
    .output(RunOutputSchema),
  runButtons: meta
    .meta({
      description:
        'Tell for each Issue whether it gets a Run button and with what prompt, reading the Issues from GitHub without tracking them',
    })
    .input(z.object({ refs: z.array(z.string()).max(100) }))
    .output(RunButtonsOutputSchema),
  runFromButton: meta
    .meta({
      description:
        'Run the Task of an Issue with the prompt its Run button has now, reading the Issue from GitHub anew, or refuse with PRECONDITION_FAILED and the reason when it gets no Run button',
    })
    .errors(runErrors)
    .input(z.object({ ref }))
    .output(RunOutputSchema),
  current: meta
    .meta({ description: 'Show the Task of the Tab this runs in', cli: true })
    .input(z.object({ terminalSessionId: z.string().optional() }))
    .output(CurrentOutputSchema),
  attach: meta
    .meta({
      description:
        "Move the Tab this runs in into the Bench of an open Task, opening the Bench in place when it has none, and make the Tab's claude a Run of the Task",
      cli: true,
    })
    .input(z.object({ ref, terminalSessionId: z.string().optional() }))
    .output(AttachOutputSchema),
  close: meta
    .meta({
      description:
        'Close a Task and take down its Bench: the worktree, the branch issue-n, the Runspace and its Tabs, all but the Tab this runs in',
      cli: true,
    })
    .errors(closeErrors)
    .input(
      z.object({
        ref,
        force: z
          .boolean()
          .optional()
          .describe('close even with live Runs, uncommitted changes or commits on no remote'),
        terminalSessionId: z.string().optional(),
      }),
    )
    .output(CloseOutputSchema),
  reopen: meta
    .meta({
      description: 'Reopen a closed Task; the next run or attach opens its Bench anew',
      cli: true,
    })
    .input(z.object({ ref }))
    .output(ReopenOutputSchema),
  bench: {
    list: meta
      .meta({ description: 'List the Benches with the labels of their Tasks' })
      .output(z.array(BenchItemSchema)),
  },
  changes: meta
    .meta({
      description:
        'Stream signals that Tasks, their Issue copies, their Benches or the Agent Sessions of their Runs changed',
    })
    .output(eventIterator(TaskChangeSchema)),
}
