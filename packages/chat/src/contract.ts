import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// ブラウザの口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})

export const MAX_ASK_BODY_BYTES = 50 * 1024 * 1024

export const UnreadableSchema = z.object({
  kind: z.literal('unreadable'),
  reason: z
    .enum(['restricted', 'timeout', 'too-large', 'fetch-failed', 'unparsable'])
    .describe(
      'restricted: the browser refused to run a script there; timeout: no reply in 3 seconds; too-large: the request would exceed the body limit; fetch-failed: the side panel could not fetch the PDF; unparsable: the Backend could not turn the HTML or the PDF into text',
    ),
  detail: z.string().optional(),
})

// chrome:// などの Browser Tab では side panel から見えず、file:// のページもあるので、url と title の形を検めない。
export const PageSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  selection: z.string().optional().describe('the text selected in the top frame of the page'),
  content: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('html'),
      html: z
        .string()
        .describe('getHTML of the document element of the top frame, with its shadow roots'),
    }),
    z.object({
      kind: z.literal('pdf'),
      pdf: z.file().describe('the bytes fetched from the URL of a Browser Tab that shows a PDF'),
    }),
    UnreadableSchema,
  ]),
})

const CutTextSchema = z.object({ text: z.string(), truncated: z.boolean() })

export const PageSnapshotSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  selection: CutTextSchema.optional(),
  content: z
    .discriminatedUnion('kind', [
      CutTextSchema.extend({
        kind: z.literal('text'),
        source: z.enum(['html', 'pdf']).describe('what the text was taken from'),
      }),
      z.object({
        kind: z.literal('same'),
        turn: z
          .number()
          .int()
          .nonnegative()
          .describe('the index in history of the turn whose page has the same URL and text'),
      }),
      UnreadableSchema,
    ])
    .optional(),
})

export const TurnSchema = z.object({
  question: z.string(),
  answer: z.string(),
  page: PageSnapshotSchema,
})

export const AskInputSchema = z.object({
  question: z.string().min(1),
  page: PageSchema.describe('the Current Page when the question was sent'),
  history: z
    .array(TurnSchema)
    .describe(
      'the earlier questions and answers of the Chat, oldest first, each with the page of its snapshot event',
    ),
})

export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    page: PageSnapshotSchema.describe('the page as the Backend read it, to keep in history'),
    omitted: z
      .object({ pages: z.number().int(), turns: z.number().int() })
      .describe('how many earlier pages and earlier questions were left out to stay in the limit'),
  }),
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

export type Unreadable = z.infer<typeof UnreadableSchema>
export type Page = z.infer<typeof PageSchema>
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>
export type Turn = z.infer<typeof TurnSchema>
export type AskInput = z.infer<typeof AskInputSchema>
export type ChatEvent = z.infer<typeof ChatEventSchema>
export type SnapshotEvent = Extract<ChatEvent, { type: 'snapshot' }>

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
        'Answer a question about the Current Page: turn the HTML or the PDF of the page into its text, send that Page Snapshot first, then stream the answer and close once it is done',
    })
    .errors(askErrors)
    .input(AskInputSchema)
    .output(eventIterator(ChatEventSchema)),
}
