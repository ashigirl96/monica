import type { ContractRouterClient } from '@orpc/contract'
import { table } from '@tania/ui/table'

import type {
  contract,
  JobExecution,
  JobItem,
  ListOutput,
  RunOutput,
  Schedule,
  ShowOutput,
} from './contract.ts'

type Client = { job: ContractRouterClient<typeof contract> }

async function jobNames(
  client: Client,
  signal: AbortSignal,
): Promise<{ value: string; description: string }[]> {
  return (await client.job.list(undefined, { signal })).jobs.map((job) => ({
    value: job.name,
    description: scheduleText(job.schedule),
  }))
}

export const completers = {
  show: { name: jobNames },
  run: { name: jobNames },
}

export const formatters = {
  list({ jobs }: ListOutput): string {
    if (jobs.length === 0) return 'No Jobs'
    return table([
      ['NAME', 'SCHEDULE', 'STATE', 'LAST', 'NEXT'],
      ...jobs.map((job) => [
        job.name,
        scheduleText(job.schedule),
        job.state,
        job.last ? `${localTime(job.last.startedAt)} ${job.last.result}` : '-',
        nextText(job),
      ]),
    ])
  },
  show(job: ShowOutput): string {
    const head = table([
      ['NAME', 'SCHEDULE', 'STATE', 'NEXT'],
      [job.name, scheduleText(job.schedule), job.state, nextText(job)],
    ])
    const executions =
      job.executions.length === 0
        ? 'No Job Executions'
        : table([
            ['STARTED', 'DURATION', 'RESULT', 'ERROR'],
            ...job.executions.map((execution) => [
              localTime(execution.startedAt),
              durationText(execution),
              execution.result ?? 'running',
              execution.error ?? '-',
            ]),
          ])
    return `${head}\n\n${executions}`
  },
  run({ name, startedAt }: RunOutput): string {
    return `started ${name} at ${localTime(startedAt)}`
  },
}

function scheduleText(schedule: Schedule): string {
  const { ms } = schedule
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
  return `every ${ms / 1000}s`
}

function nextText({ nextAt }: Pick<JobItem, 'nextAt'>): string {
  return nextAt ? localTime(nextAt) : '-'
}

function durationText({ startedAt, endedAt }: JobExecution): string {
  if (!endedAt) return '-'
  const ms = endedAt.getTime() - startedAt.getTime()
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`
}

function localTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
