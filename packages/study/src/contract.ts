import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// ブラウザの口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})

export const StudyIdSchema = z
  .string()
  .regex(/^study-[0-9a-f-]+$/)
  .describe('study-<uuidv7>')

export const StudyMessageSchema = z.object({
  id: z.number().int().describe('the row number; rows are ordered by it'),
  conversationId: z.string(),
  kind: z
    .enum(['user', 'tutor', 'tool', 'tutor_switch', 'permission'])
    .describe(
      'user: what the user said; tutor: what the Tutor said; tool: a tool the Tutor ran; tutor_switch: the Tutor changed; permission: the Tutor asked to run a command outside the box',
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
          z.object({
            id: StudyIdSchema,
            missionLine,
            firstMessage,
            lastActivityAt: z.date(),
            lastLogLine: z
              .string()
              .nullable()
              .describe(
                'the last non-empty line of log.md that is not a heading, without its leading "- "',
              ),
            waitingPermission: z
              .boolean()
              .describe('a permission row of the Study waits for the answer'),
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
  permission: {
    answer: meta
      .meta({
        description:
          'Answer a permission row: allow or deny running its command outside the box; a row already answered stays as it is',
      })
      .input(z.object({ id: z.number().int(), allow: z.boolean() }))
      .output(StudyMessageSchema),
  },
}
