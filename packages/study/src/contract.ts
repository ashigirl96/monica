import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// trpc-cli には出さない（study shell は手書きの command）ので、meta に cli を持たない。
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

// GitHub の repo 名は大文字と小文字を区別しない。
export const repoKey = (repo: string) => repo.toLowerCase()

const repos = z.array(RepoSchema).describe('the linked Repos as spelled when linked, in link order')

export const StudyMessageSchema = z.object({
  id: z.number().int().describe('the row number; rows are ordered by it'),
  conversationId: z.string(),
  kind: z
    .enum(['user', 'tutor', 'tool', 'tutor_switch', 'permission', 'reflection'])
    .describe(
      'user: what the user said; tutor: what the Tutor said; tool: a tool the Tutor ran; tutor_switch: the Tutor changed; permission: the Tutor asked to run a command outside the box; reflection: monica asked the Tutor to reflect on the ending Study Conversation, with empty text',
    ),
  text: z
    .string()
    .describe(
      'the utterance, the Tutor text, what the tool ran on, the name of the Tutor switched to, or the whole command asked for',
    ),
  tool: z.string().nullable().describe('the tool name on a tool row, null on the others'),
  reason: z
    .string()
    .nullable()
    .describe('why the Tutor asked, on a permission row; null without one and on the others'),
  state: z
    .enum(['pending', 'allowed', 'denied'])
    .nullable()
    .describe('the answer on a permission row, null on the others'),
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
  z.object({ type: z.literal('conversation-ended'), conversationId: z.string() }),
  z.object({
    type: z.literal('turn-ended'),
    error: z
      .string()
      .nullable()
      .describe('the result text or the tail of the claude stderr when the turn failed'),
  }),
])

export type StudyWatchEvent = z.infer<typeof StudyWatchEventSchema>

// chat と同じ形。study は chat を import しないので写す。
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export type Effort = z.infer<typeof EffortSchema>

export const ChoiceSchema = z.object({
  model: z
    .string()
    .min(1)
    .optional()
    .describe('the value of a model from models; the default model of claude when left out'),
  effort: EffortSchema.optional().describe('the default effort of the model when left out'),
})

export type Choice = z.infer<typeof ChoiceSchema>

export const ModelSchema = z.object({
  value: z.string().describe('what to pass as the model of send'),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(EffortSchema).optional(),
})

export type Model = z.infer<typeof ModelSchema>

export const StudyRefusalSchema = z
  .enum([
    'turn-running',
    'conversation-ending',
    'playground-cleaning',
    'study-removing',
    'tutor-capacity',
  ])
  .describe(
    'turn-running: a turn of the Study is running; conversation-ending: its Study Conversation is being ended; playground-cleaning: its Playground is being cleaned up; study-removing: it is being removed; tutor-capacity: every Tutor claude the Backend may hold is in a turn of another Study',
  )

export type StudyRefusal = z.infer<typeof StudyRefusalSchema>

const refusalData = z.object({ reason: StudyRefusalSchema })

export const studyErrors = {
  CONFLICT: { status: 409, message: 'the Study cannot take this now', data: refusalData },
  TOO_MANY_REQUESTS: {
    status: 429,
    message: 'every Tutor claude is in a turn',
    data: refusalData,
  },
}

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
            waitingPermission: z
              .boolean()
              .describe('a permission row of the Study waits for the answer'),
            playgroundRemoved: z
              .boolean()
              .describe('the Playground was removed after the last activity of the Study'),
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
            summary: z
              .string()
              .nullable()
              .describe(
                'on an ended Study Conversation, the first line of the Tutor report, or why it ended without a reflection; null on the others',
              ),
            messages: z.array(StudyMessageSchema),
          }),
        ),
      }),
    ),
  send: meta
    .meta({
      description:
        'Store what the user said and start a turn of the Tutor on the model and effort; returns the stored row without waiting for the turn, whose answer comes through watch',
    })
    .errors(studyErrors)
    .input(ChoiceSchema.extend({ id: StudyIdSchema, text: z.string().min(1) }))
    .output(z.object({ message: StudyMessageSchema })),
  models: meta
    .meta({
      description:
        'List the models that claude offers the Tutor, each with the effort levels it supports; the Backend reads them once and keeps them',
    })
    .input(z.object({}))
    .output(z.array(ModelSchema)),
  watch: meta
    .meta({
      description:
        'Stream the turns of a Study: a snapshot first, then the rows, the Tutor text and the turn ends; closing it does not stop the turn',
    })
    .input(z.object({ id: StudyIdSchema }))
    .output(eventIterator(StudyWatchEventSchema)),
  conversation: {
    end: meta
      .meta({
        description:
          'End the ongoing Study Conversation of a Study: deny its pending permission and stop its turn; with reflect, start the reflection turn and return without waiting for it, whose rows come through watch',
      })
      .errors(studyErrors)
      .input(
        z.object({
          id: StudyIdSchema,
          reflect: z
            .boolean()
            .optional()
            .describe('have the Tutor reflect on it before it ends; false when left out'),
        }),
      )
      .output(z.object({ conversationId: z.string() })),
  },
  remove: meta
    .meta({
      description:
        'Remove a Study for good: stop its turn, move its dir to the trash, delete its row with its Study Conversations and Repo links, and its claude sessions; the Learning Preference stays',
    })
    .errors(studyErrors)
    .input(z.object({ id: StudyIdSchema }))
    .output(z.object({})),
  permission: {
    answer: meta
      .meta({
        description:
          'Answer a permission row: allow or deny running its command outside the box; a row already answered stays as it is',
      })
      .input(z.object({ id: z.number().int(), allow: z.boolean() }))
      .output(StudyMessageSchema),
  },
  shell: meta
    .meta({
      description:
        'Find the one Study whose id starts with the prefix, mark it active, and give what its shell needs',
    })
    .errors(studyErrors)
    .input(
      z.object({
        prefix: z
          .string()
          .transform((prefix) => prefix.toLowerCase().replace(/^study-/, ''))
          .pipe(z.string().regex(/^[0-9a-f-]+$/))
          .describe('the head of the Study id, with or without study-'),
      }),
    )
    .output(
      z.object({
        studyId: StudyIdSchema,
        dir: z.string().describe('the absolute path of the Study dir'),
        env: z.record(z.string(), z.string()).describe('the Playground env'),
        zdotdir: z.string().describe('the ZDOTDIR whose files read env/env.sh after the user rc'),
      }),
    ),
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

/** 画面と CLI が打たせる短い id。`study-` の後の頭 8 文字。 */
export const shortIdOf = (studyId: string) => studyId.slice('study-'.length, 'study-'.length + 8)
