import { z } from 'zod'

const sequence = { version: z.literal(1), sequence: z.number().int().positive() }
export const TerminalFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...sequence,
      type: z.literal('output'),
      data: z
        .string()
        .max(61_440)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
  z
    .object({
      ...sequence,
      type: z.literal('size'),
      generation: z.number().int().nonnegative(),
      rows: z.number().int().min(1).max(65535),
      cols: z.number().int().min(1).max(65535),
    })
    .strict(),
  z.object({ ...sequence, type: z.literal('replay_end') }).strict(),
  z
    .object({ ...sequence, type: z.literal('exit'), exitCode: z.number().int().nullable() })
    .strict(),
  z.object({ version: z.literal(1), type: z.literal('closed') }).strict(),
])
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>
export const TerminalControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('open'),
      tabId: z.string().min(1).max(128),
      terminalSessionId: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ type: z.literal('ack'), sequence: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('close') }).strict(),
])
