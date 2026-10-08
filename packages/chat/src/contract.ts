import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// ブラウザの口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})

export const MAX_ASK_BODY_BYTES = 50 * 1024 * 1024

// chrome:// などの Browser Tab では side panel から見えず、file:// のページもあるので、形を検めない。
export const PageSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
})

export const TurnSchema = z.object({
  question: z.string(),
  page: PageSchema,
  answer: z.string(),
})

export const AskInputSchema = z.object({
  question: z.string().min(1),
  page: PageSchema.describe('the Current Page when the question was sent'),
  history: z
    .array(TurnSchema)
    .describe('the earlier questions and answers of the Chat, oldest first'),
})

export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().describe('the next piece of the answer, to append as it is'),
  }),
])

export const askErrors = {
  CHAT_BUSY: {
    status: 429,
    message: 'the Backend is already running as many claude processes as it may',
  },
}

export type Page = z.infer<typeof PageSchema>
export type Turn = z.infer<typeof TurnSchema>
export type AskInput = z.infer<typeof AskInputSchema>
export type ChatEvent = z.infer<typeof ChatEventSchema>

export const contract = {
  prepare: meta
    .meta({
      description:
        'Start a spare claude so that the next question is answered sooner; returns without waiting for it',
    })
    .output(z.void()),
  ask: meta
    .meta({
      description:
        'Answer a question about the Current Page, streaming the answer and closing once it is done',
    })
    .errors(askErrors)
    .input(AskInputSchema)
    .output(eventIterator(ChatEventSchema)),
}
