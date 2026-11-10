import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// ブラウザの口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})

export const StudyIdSchema = z
  .string()
  .regex(/^study-[0-9a-f-]+$/)
  .describe('study-<uuidv7>')

// note と同じ形。study は note を import しないので写す。
export const RepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
  .describe('owner/repo')

const repos = z.array(RepoSchema).describe('the linked Repos as spelled when linked, in link order')

export const StudyMessageSchema = z.object({
  id: z.number().int().describe('the row number; rows are ordered by it'),
  conversationId: z.string(),
  kind: z
    .enum(['user', 'tutor', 'tool', 'tutor_switch'])
    .describe(
      'user: what the user said; tutor: what the Tutor said; tool: a tool the Tutor ran; tutor_switch: the Tutor changed',
    ),
  text: z
    .string()
    .describe(
      'the utterance, the Tutor text, what the tool ran on, or the name of the Tutor switched to',
    ),
  tool: z.string().nullable().describe('the tool name on a tool row, null on the others'),
  createdAt: z.date(),
})

export type StudyMessage = z.infer<typeof StudyMessageSchema>

const missionLine = z
  .string()
  .nullable()
  .describe('the first non-empty line of MISSION.md without its leading #; null without one')
const firstMessage = z
  .string()
  .nullable()
  .describe('the first line of the first utterance of the first Study Conversation; null before it')

const StudySummarySchema = z.object({
  id: StudyIdSchema,
  missionLine,
  firstMessage,
  lastActivityAt: z.date(),
})

export const StudyWatchEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    running: z.boolean(),
    lastMessageId: z
      .number()
      .int()
      .nullable()
      .describe(
        'the last row of the Study stored when the watch opened; later rows come as events',
      ),
    partialText: z.string().describe('the Tutor text of the running turn after its last tutor row'),
  }),
  z.object({ type: z.literal('turn-started'), conversationId: z.string() }),
  z.object({ type: z.literal('message'), message: StudyMessageSchema }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('turn-ended'),
    error: z
      .string()
      .nullable()
      .describe('the result text or the tail of the claude stderr when the turn failed'),
  }),
])

export type StudyWatchEvent = z.infer<typeof StudyWatchEventSchema>

const ArtifactPathSchema = z.string().min(1).describe('a path relative to the Study dir')

export const contract = {
  start: meta
    .meta({ description: 'Start a Study: make its row and its dir, without a conversation yet' })
    .input(z.object({}))
    .output(z.object({ id: StudyIdSchema })),
  list: meta
    .meta({ description: 'List the Studies, the most recently active first' })
    .input(z.object({}))
    .output(
      z.object({
        studies: z.array(
          StudySummarySchema.extend({
            lastLogLine: z
              .string()
              .nullable()
              .describe(
                'the last non-empty line of log.md that is not a heading, without its leading "- "',
              ),
            repos,
          }),
        ),
      }),
    ),
  get: meta
    .meta({
      description:
        'Read a Study with its Study Conversations, the newest first, each with its rows, the oldest first',
    })
    .input(z.object({ id: StudyIdSchema }))
    .output(
      z.object({
        id: StudyIdSchema,
        dir: z.string().describe('the absolute path of the Study dir'),
        missionLine,
        firstMessage,
        running: z.boolean().describe('a turn of this Study is running'),
        repos,
        conversations: z.array(
          z.object({
            id: z.string(),
            startedAt: z.date(),
            endedAt: z.date().nullable(),
            messages: z.array(StudyMessageSchema),
          }),
        ),
      }),
    ),
  send: meta
    .meta({
      description:
        'Store what the user said and start a turn of the Tutor; returns the stored row without waiting for the turn, whose answer comes through watch',
    })
    .input(z.object({ id: StudyIdSchema, text: z.string().min(1) }))
    .output(z.object({ message: StudyMessageSchema })),
  watch: meta
    .meta({
      description:
        'Stream the turns of a Study: a snapshot first, then the rows, the Tutor text and the turn ends; closing it does not stop the turn',
    })
    .input(z.object({ id: StudyIdSchema }))
    .output(eventIterator(StudyWatchEventSchema)),
  repo: {
    link: meta
      .meta({
        description:
          'Link a Repo to a Study; a Repo already linked in any case is left as first spelled',
      })
      .input(z.object({ id: StudyIdSchema, repo: RepoSchema }))
      .output(z.object({})),
    unlink: meta
      .meta({
        description: 'Unlink a Repo from a Study in any case; a Repo not linked is no error',
      })
      .input(z.object({ id: StudyIdSchema, repo: RepoSchema }))
      .output(z.object({})),
    studies: meta
      .meta({
        description:
          'List the Studies linked to a Repo in any case, the most recently active first',
      })
      .input(z.object({ repo: RepoSchema }))
      .output(z.object({ studies: z.array(StudySummarySchema) })),
  },
  artifact: {
    list: meta
      .meta({
        description:
          'List the artifacts of a Study: MISSION.md, RESOURCES.md, GLOSSARY.md and log.md that exist, then the Learning Records by name',
      })
      .input(z.object({ id: StudyIdSchema }))
      .output(
        z.object({
          artifacts: z.array(
            z.object({
              path: ArtifactPathSchema,
              title: z
                .string()
                .nullable()
                .describe(
                  'the first # heading of a Learning Record, or its file name without the number; null on the others',
                ),
            }),
          ),
        }),
      ),
    read: meta
      .meta({ description: 'Read a regular file in the Study dir, up to 1 MiB' })
      .input(z.object({ id: StudyIdSchema, path: ArtifactPathSchema }))
      .output(z.object({ path: ArtifactPathSchema, content: z.string() })),
    open: meta
      .meta({ description: 'Open a regular file in the Study dir in Zed' })
      .input(z.object({ id: StudyIdSchema, path: ArtifactPathSchema }))
      .output(z.void()),
  },
}
