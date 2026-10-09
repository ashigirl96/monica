import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

// ブラウザの口にだけ載せ、CLI には出さないので、meta に cli を持たない。
const meta = oc.$meta<{ description?: string }>({})

export const MAX_ASK_BODY_BYTES = 50 * 1024 * 1024

export const UnreadableSchema = z.object({
  kind: z.literal('unreadable'),
  reason: z
    .enum(['restricted', 'timeout', 'too-large', 'unparsable'])
    .describe(
      'restricted: the browser refused to run a script there; timeout: no reply in 3 seconds; too-large: the request would exceed the body limit; unparsable: the Backend could not turn the HTML into text',
    ),
  detail: z.string().optional(),
})

const screenshot = {
  screenshot: z
    .base64()
    .optional()
    .describe(
      'the visible part of the Browser Tab, taken when the question was sent, as JPEG in base64 without the data: prefix',
    ),
  screenshotFailed: z
    .object({ reason: z.string() })
    .optional()
    .describe('the user asked for a screenshot but it could not be taken'),
}

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
    UnreadableSchema,
  ]),
  ...screenshot,
})

const CutTextSchema = z.object({ text: z.string(), truncated: z.boolean() })

export const PageSnapshotSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  selection: CutTextSchema.optional(),
  ...screenshot,
  content: z
    .discriminatedUnion('kind', [
      CutTextSchema.extend({ kind: z.literal('text') }),
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
    // 数百 KB の文字列を往復させないよう、スクリーンショットは返さず、side panel が自分の撮ったものを足す。
    page: PageSnapshotSchema.omit({ screenshot: true }).describe(
      'the page as the Backend read it, to keep in history with the screenshot that was sent',
    ),
    omitted: z
      .object({ pages: z.number().int(), turns: z.number().int() })
      .describe('how many earlier pages and earlier questions were left out to stay in the limit'),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string().describe('the next piece of the answer, to append as it is'),
  }),
  z
    .object({
      type: z.literal('retry'),
      attempt: z.number().int().describe('which retry this is, from 1'),
    })
    .describe(
      'claude is retrying a failed request to the Anthropic API and answers from the start; drop the answer so far',
    ),
  z
    .object({
      type: z.literal('usage'),
      utilization: z.number().describe('how much of the plan limit is used, from 0 to 1'),
      rateLimitType: z.string().describe('which limit, such as five_hour or seven_day'),
      resetsAt: z.number().optional().describe('when the limit resets, in unix seconds'),
    })
    .describe('the answer came near the plan limit, which Chat shares with the agents in Tabs'),
])

export const askErrors = {
  CHAT_BUSY: {
    status: 429,
    message: 'the Backend is already running as many claude processes as it may',
  },
  NOT_AUTHENTICATED: {
    status: 401,
    message: 'claude is not logged in to Claude Code',
  },
  USAGE_LIMIT: {
    status: 429,
    message: 'the plan has hit its usage limit',
    // CLI が版ごとに足す値でも data が schema を通るよう、rateLimitType は enum にしない。
    data: z.object({
      rateLimitType: z.string(),
      resetsAt: z.number().describe('unix seconds'),
    }),
  },
  AGENT_FAILED: {
    status: 500,
    message: 'claude could not answer',
    data: z.object({ detail: z.string().describe('what claude or the Agent SDK said, as it is') }),
  },
}

export type Unreadable = z.infer<typeof UnreadableSchema>
export type Page = z.infer<typeof PageSchema>
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>
export type Turn = z.infer<typeof TurnSchema>
export type AskInput = z.infer<typeof AskInputSchema>
export type ChatEvent = z.infer<typeof ChatEventSchema>
export type SnapshotEvent = Extract<ChatEvent, { type: 'snapshot' }>
export type UsageEvent = Extract<ChatEvent, { type: 'usage' }>

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
        'Answer a question about the Current Page: turn the HTML of the page into its text, send that Page Snapshot first, then stream the answer and close once it is done; a failure after that ends the stream with one of the declared errors',
    })
    .errors(askErrors)
    .input(AskInputSchema)
    .output(eventIterator(ChatEventSchema)),
}
