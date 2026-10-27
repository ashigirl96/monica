import { eventIterator, oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { agentSession, runspace, tab, terminalSession } from './schema.ts'

const meta = oc.$meta<{ description?: string; cli?: boolean }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

export const TerminalSessionSchema = createSelectSchema(terminalSession).extend({
  tabId: z.string().nullable(),
})

export const TabSchema = createSelectSchema(tab).omit({ runspaceId: true })

export const LayoutSchema = z.object({
  runspaces: z.array(createSelectSchema(runspace).extend({ tabs: z.array(TabSchema) })),
})

export const AgentSessionSchema = createSelectSchema(agentSession)

export const ProcessInfoSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  pgid: z.number().int(),
  state: z.string().describe("ps's STAT, such as Ss or SN"),
  command: z.string(),
  terminalSessionProcess: z
    .boolean()
    .describe('in the session of the shell, so the end of the Terminal Session stops it'),
})

export const ShownTabSchema = z.object({
  tab: TabSchema,
  terminalSession: createSelectSchema(terminalSession),
  processes: z
    .array(ProcessInfoSchema)
    .nullable()
    .describe(
      "the Terminal Session Processes and the shell's descendants that left its session, or null when monica-ptyd could not list them",
    ),
})

export const ShownRunspaceSchema = z.object({
  runspace: createSelectSchema(runspace),
  tabs: z.array(ShownTabSchema).describe('in the order of the Tabs of the Runspace'),
})

export const ListedAgentSessionSchema = AgentSessionSchema.extend({
  unread: z.boolean().describe('a notified wait no one has seen in its Tab yet'),
})

// 合図だけを流す。購読側は payload を信じず読み直す。
export const WorkbenchChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('layout') }),
  z.object({ type: z.literal('terminalSession'), id: z.string() }),
  z.object({ type: z.literal('agentSession'), sessionId: z.string() }),
  z.object({ type: z.literal('reconciled') }),
  // 空になったかは閉じた transaction でしか決まらず、読み直しでは分からないので id を載せる。
  z.object({ type: z.literal('runspaceEmptied'), runspaceId: z.string() }),
])

export const RepoPlaceSchema = z.object({
  repo: z.string().nullable().describe('owner/repo, or null outside every Repo'),
  path: z
    .string()
    .describe(
      "the directory as the sidebar shows it: in a Repo, relative to the top of its checkout or worktree (the top's own name at the top); outside, with the home folded into ~",
    ),
  branch: z.string().nullable().describe('the branch checked out, only in a linked worktree'),
})

export type TerminalSession = z.infer<typeof TerminalSessionSchema>
export type Tab = z.infer<typeof TabSchema>
export type Layout = z.infer<typeof LayoutSchema>
export type AgentSession = z.infer<typeof AgentSessionSchema>
export type ShownTab = z.infer<typeof ShownTabSchema>
export type ShownRunspace = z.infer<typeof ShownRunspaceSchema>
export type ListedAgentSession = z.infer<typeof ListedAgentSessionSchema>
export type WorkbenchChange = z.infer<typeof WorkbenchChangeSchema>
export type RepoPlace = z.infer<typeof RepoPlaceSchema>

// id を省くと、CLI が env から埋める terminalSessionId の Tab を指す。
const callerOr = (what: string) => ({
  id: z
    .string()
    .meta({
      positional: true,
      description: `the id of the ${what}; the one this runs in if left out`,
    })
    .optional(),
  terminalSessionId: z.string().optional(),
})

const size = { rows: z.number().int().positive(), cols: z.number().int().positive() }
const index = z.number().int().nonnegative()

export const contract = {
  terminalSession: {
    list: meta
      .meta({ description: 'List Terminal Sessions that are live or shown in a Tab', cli: true })
      .output(z.array(TerminalSessionSchema)),
  },
  layout: {
    get: meta
      .meta({ description: 'Read the Runspaces and their Tabs in order' })
      .output(LayoutSchema),
  },
  runspace: {
    create: meta
      .meta({ description: 'Open a Runspace with one Tab on a new Terminal Session' })
      .input(z.object({ cwd: z.string().optional(), index: index.optional(), ...size }))
      .output(z.object({ runspaceId: z.string(), tab: TabSchema })),
    remove: meta
      .meta({
        description: 'Remove a Runspace with its Tabs and terminate their Terminal Sessions',
        cli: true,
      })
      .input(z.object(callerOr('Runspace')))
      .output(z.object({ runspaceId: z.string() })),
    show: meta
      .meta({ description: 'Show a Runspace with each of its Tabs as tab show does', cli: true })
      .input(z.object(callerOr('Runspace')))
      .output(ShownRunspaceSchema),
    move: meta
      .meta({ description: 'Move a Runspace to a position in the sidebar' })
      .input(z.object({ id: z.string(), index }))
      .output(z.void()),
  },
  tab: {
    open: meta
      .meta({ description: 'Open a Tab on a new Terminal Session' })
      .input(
        z.object({
          runspaceId: z.string(),
          cwd: z.string().optional(),
          index: index.optional(),
          ...size,
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
      .meta({ description: 'Close a Tab and terminate its Terminal Session', cli: true })
      .input(z.object(callerOr('Tab')))
      .output(
        z.object({
          tabId: z.string(),
          emptiedRunspaceId: z
            .string()
            .nullable()
            .describe('the owned Runspace this close left with no Tabs, or null'),
        }),
      ),
    show: meta
      .meta({ description: 'Show a Tab with its Terminal Session and processes', cli: true })
      .input(z.object(callerOr('Tab')))
      .output(ShownTabSchema),
    move: meta
      .meta({ description: 'Move a Tab to a position in a Runspace' })
      .input(z.object({ id: z.string(), runspaceId: z.string(), index }))
      .output(z.void()),
    setCwd: meta
      .meta({ description: 'Record the last known cwd of a Tab' })
      .input(z.object({ id: z.string(), cwd: z.string() }))
      .output(z.void()),
    pin: meta
      .meta({
        description:
          'Pin a Tab, moving the pin from another Tab of its Runspace or splitting it into a new Runspace',
      })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
    unpin: meta
      .meta({ description: 'Unpin a Tab, leaving it in its Runspace' })
      .input(z.object({ id: z.string() }))
      .output(z.void()),
  },
  agentSession: {
    recordHook: meta
      .meta({ description: 'Apply a Claude Code hook from a Tab to its Agent Session' })
      .input(
        z.object({ terminalSessionId: z.string(), payload: z.record(z.string(), z.unknown()) }),
      )
      .output(z.void()),
    list: meta
      .meta({ description: 'List Agent Sessions that have not ended', cli: true })
      .output(z.array(ListedAgentSessionSchema)),
    markSeen: meta
      .meta({ description: "Record that an Agent Session's notified wait was seen in its Tab" })
      .input(
        z.object({
          sessionId: z.string(),
          notifiedAt: z.date().describe('notifiedAt of the notification that was seen'),
        }),
      )
      .output(z.void()),
  },
  repo: {
    of: meta
      .meta({
        description: 'Name the Repo whose checkout or worktree a directory is in, if any',
      })
      .input(z.object({ cwd: z.string() }))
      .output(RepoPlaceSchema),
  },
  editor: {
    resolve: meta
      .meta({
        description:
          'Resolve paths printed in a terminal to existing files, or null where none exists',
      })
      .input(z.object({ cwd: z.string(), candidates: z.array(z.string()) }))
      .output(z.array(z.string().nullable())),
    open: meta
      .meta({ description: 'Open a file in Zed' })
      .input(z.object({ path: z.string() }))
      .output(z.void()),
  },
  changes: meta
    .meta({ description: 'Stream signals that the Workbench Ledger changed' })
    .output(eventIterator(WorkbenchChangeSchema)),
}
