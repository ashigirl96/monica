import { oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { usage } from './schema.ts'

const meta = oc.$meta<{ description?: string; cli?: boolean }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

const UsageRowSchema = createSelectSchema(usage)

export const CallerSchema = UsageRowSchema.shape.caller

export const UsageItemSchema = z.object({
  feature: UsageRowSchema.shape.feature,
  caller: CallerSchema.nullable().describe('null for a Feature no Caller has called'),
  ok: z.number().int().describe('the calls that returned, over all days'),
  failed: z.number().int().describe('the calls that threw, over all days'),
  lastUsed: UsageRowSchema.shape.date
    .nullable()
    .describe('the local day of the latest call as YYYY-MM-DD, or null for never'),
})

export const ListOutputSchema = z.object({
  usages: z
    .array(UsageItemSchema)
    .describe('one item per Feature and Caller, never-called Features first, then oldest first'),
})

export type Caller = z.infer<typeof CallerSchema>
export type UsageItem = z.infer<typeof UsageItemSchema>
export type ListOutput = z.infer<typeof ListOutputSchema>

export const contract = {
  list: meta
    .meta({
      description:
        'List the Usage of every Feature by Caller, with Features no one has called as 0 calls',
      cli: true,
    })
    .output(ListOutputSchema),
}
