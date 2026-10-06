import { oc } from '@orpc/contract'
import { createSchemaFactory } from 'drizzle-zod'
import { z } from 'zod'

import { job, jobExecution } from './schema.ts'

const meta = oc.$meta<{ description?: string; cli?: boolean }>({})
const { createSelectSchema } = createSchemaFactory({ coerce: { date: true } })

const UserJobSchema = createSelectSchema(job)

export const JobExecutionSchema = createSelectSchema(jobExecution).omit({ id: true, jobName: true })

export const ScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('every'), ms: z.number().int().positive() }),
  z.object({
    type: z.literal('cron'),
    expression: UserJobSchema.shape.schedule.describe('5 fields, read in local time'),
  }),
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
  shell: UserJobSchema.pick({ command: true, cwd: true, timeoutMs: true })
    .nullable()
    .describe(
      'the shell command of a user Job with where and how long it runs, or null for a system Job',
    ),
  executions: z.array(JobExecutionSchema).describe('the latest Job Executions, newest first'),
})

export const RunOutputSchema = z.object({ name: z.string(), startedAt: z.date() })

export const AddOutputSchema = z.object({ name: z.string(), nextAt: JobSchema.shape.nextAt })

export const RemoveOutputSchema = z.object({ name: z.string() })

export const PauseOutputSchema = z.object({ name: z.string() })

export const ResumeOutputSchema = z.object({ name: z.string(), nextAt: JobSchema.shape.nextAt })

export type Schedule = z.infer<typeof ScheduleSchema>
export type JobExecution = z.infer<typeof JobExecutionSchema>
export type JobItem = z.infer<typeof JobItemSchema>
export type ListOutput = z.infer<typeof ListOutputSchema>
export type ShowOutput = z.infer<typeof ShowOutputSchema>
export type RunOutput = z.infer<typeof RunOutputSchema>
export type AddOutput = z.infer<typeof AddOutputSchema>
export type RemoveOutput = z.infer<typeof RemoveOutputSchema>
export type PauseOutput = z.infer<typeof PauseOutputSchema>
export type ResumeOutput = z.infer<typeof ResumeOutputSchema>

const name = z.string().meta({ positional: true, description: 'the name of the Job' })

// . は system の Job（<domain>.<name>）のために取ってある。
const userJobName = z
  .string()
  .regex(
    /^[a-z0-9-]+$/,
    'a Job name takes only lowercase letters, digits and -; names with . are kept for system Jobs',
  )
  .meta({ positional: true, description: 'the name of the Job: lowercase letters, digits and -' })

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
  add: meta
    .meta({
      description:
        'Add a Job that runs a shell command with /bin/sh -c on a cron schedule in local time',
      cli: true,
    })
    .input(
      z.object({
        name: userJobName,
        schedule: z.string().describe("a cron expression of 5 fields, such as '0 3 * * *'"),
        command: z.string().describe('the shell command, run with /bin/sh -c'),
        cwd: z
          .string()
          .optional()
          .describe('the absolute path of the directory it runs in; $HOME if omitted'),
        timeout: z
          .string()
          .optional()
          .describe(
            'how long it may run before its process group is killed, such as 30m; 1h if omitted',
          ),
      }),
    )
    .output(AddOutputSchema),
  remove: meta
    .meta({ description: 'Remove a user Job with its Job Executions and their logs', cli: true })
    .input(z.object({ name }))
    .output(RemoveOutputSchema),
  pause: meta
    .meta({
      description:
        'Pause a user Job so that it no longer runs on its schedule; run still starts it',
      cli: true,
    })
    .input(z.object({ name }))
    .output(PauseOutputSchema),
  resume: meta
    .meta({
      description: 'Resume a paused user Job; its next scheduled time counts from now',
      cli: true,
    })
    .input(z.object({ name }))
    .output(ResumeOutputSchema),
}
