import { oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { jobExecution } from './schema.ts'

const meta = oc.$meta<{ description?: string; cli?: boolean }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

export const JobExecutionSchema = createSelectSchema(jobExecution).omit({ id: true, jobName: true })

export const ScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('every'), ms: z.number().int().positive() }),
])

const JobSchema = z.object({
  name: z.string(),
  schedule: ScheduleSchema,
  state: z.enum(['active', 'paused', 'running']),
  nextAt: z.date().nullable().describe('when the next Job Execution is due, or null for none'),
})

export const JobItemSchema = JobSchema.extend({
  last: z
    .object({
      startedAt: JobExecutionSchema.shape.startedAt,
      result: JobExecutionSchema.shape.result.unwrap(),
    })
    .nullable()
    .describe('the latest Job Execution that has ended, or null for none'),
})

export const ListOutputSchema = z.object({ jobs: z.array(JobItemSchema) })

export const ShowOutputSchema = JobSchema.extend({
  executions: z.array(JobExecutionSchema).describe('the latest Job Executions, newest first'),
})

export const RunOutputSchema = z.object({ name: z.string(), startedAt: z.date() })

export type Schedule = z.infer<typeof ScheduleSchema>
export type JobExecution = z.infer<typeof JobExecutionSchema>
export type JobItem = z.infer<typeof JobItemSchema>
export type ListOutput = z.infer<typeof ListOutputSchema>
export type ShowOutput = z.infer<typeof ShowOutputSchema>
export type RunOutput = z.infer<typeof RunOutputSchema>

const name = z.string().meta({ positional: true, description: 'the name of the Job' })

export const contract = {
  list: meta
    .meta({
      description: 'List the Jobs with when each last started, how it ended and when it runs next',
      cli: true,
    })
    .output(ListOutputSchema),
  show: meta
    .meta({
      description: 'Show the schedule of a Job and its latest Job Executions, newest first',
      cli: true,
    })
    .input(z.object({ name }))
    .output(ShowOutputSchema),
  run: meta
    .meta({
      description:
        'Start a Job now and return without waiting for it to end; its next scheduled time stays',
      cli: true,
    })
    .input(z.object({ name }))
    .output(RunOutputSchema),
}
