import { z } from 'zod'

export const RendererGenerationSchema = z
  .object({ renderer: z.number().int().positive(), connection: z.number().int().nonnegative() })
  .strict()
export type RendererGeneration = z.infer<typeof RendererGenerationSchema>
export const InputResultSchema = z.enum(['accepted', 'not-sent', 'uncertain'])
export type InputResult = z.infer<typeof InputResultSchema>
export const TerminalInputSchema = z
  .object({
    type: z.literal('input'),
    id: z.number().int().positive(),
    generation: RendererGenerationSchema,
    data: z
      .string()
      .max(87384)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine((data) => atob(data).length <= 65536),
  })
  .strict()
export type TerminalInput = z.infer<typeof TerminalInputSchema>
const sequence = { version: z.literal(1), sequence: z.number().int().positive() }
export const TerminalFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(1),
      type: z.literal('renderer'),
      generation: RendererGenerationSchema.nullable(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal('input_result'),
      id: z.number().int().positive(),
      result: InputResultSchema,
    })
    .strict(),
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
  TerminalInputSchema,
  z.object({ type: z.literal('prepare') }).strict(),
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
