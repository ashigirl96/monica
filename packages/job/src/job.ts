import { ORPCError } from '@orpc/server'
import { and, desc, eq, getTableColumns, isNotNull, isNull, lt } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { JobItem, RunOutput, ShowOutput } from './contract.ts'
import { jobExecution } from './schema.ts'

export type Db = BunSQLiteDatabase

/** `run` は失敗なら reject する。 */
export type SystemJob = { name: string; every: number; run: () => Promise<void> }

export type JobLedger = {
  start(): void
  stop(): void
}

type Internals = {
  list(): JobItem[]
  show(name: string): ShowOutput
  run(name: string): RunOutput
}

type JobRuntime = { job: SystemJob; nextAt: Date | null; running: boolean }

const TICK_MS = 30_000
const SHOWN_JOB_EXECUTIONS = 20
const KEPT_JOB_EXECUTIONS = 100

// JobLedger の型は start / stop だけに保ち、Job の一覧と起こし方は JobLedger を key にここへ置く。
const internalsOf = new WeakMap<JobLedger, Internals>()

export function internals(jobLedger: JobLedger): Internals {
  const found = internalsOf.get(jobLedger)
  if (!found) throw new Error('this JobLedger was not made by createJobLedger')
  return found
}

export function createJobLedger(deps: {
  db: Db
  systemJobs: SystemJob[]
  now?: () => Date
}): JobLedger {
  const { db, systemJobs, now = () => new Date() } = deps
  const runtimes = new Map<string, JobRuntime>()
  for (const job of systemJobs) {
    if (runtimes.has(job.name)) throw new Error(`two system Jobs are named ${job.name}`)
    runtimes.set(job.name, { job, nextAt: null, running: false })
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  // 古い行は足す側で消すので、走っている回を含めても 100 件を超えない。
  function launch(runtime: JobRuntime, scheduledAt: Date): Date {
    const { name } = runtime.job
    const startedAt = now()
    const id = db.transaction((tx) => {
      const inserted = tx
        .insert(jobExecution)
        .values({ jobName: name, scheduledAt, startedAt })
        .returning({ id: jobExecution.id })
        .get()
      const oldestKept = tx
        .select({ id: jobExecution.id })
        .from(jobExecution)
        .where(eq(jobExecution.jobName, name))
        .orderBy(desc(jobExecution.id))
        .limit(1)
        .offset(KEPT_JOB_EXECUTIONS - 1)
        .get()
      if (oldestKept) {
        tx.delete(jobExecution)
          .where(and(eq(jobExecution.jobName, name), lt(jobExecution.id, oldestKept.id)))
          .run()
      }
      return inserted.id
    })
    runtime.running = true
    void runAndRecord(runtime, id)
    return startedAt
  }

  async function runAndRecord(runtime: JobRuntime, id: number) {
    let error: string | null = null
    try {
      await runtime.job.run()
    } catch (thrown) {
      error = firstLine(thrown)
    }
    const endedAt = now()
    runtime.running = false
    // tick の前に終わっても、予定の時刻には走っていたので、その回は飛ばす。
    if (runtime.nextAt && runtime.nextAt <= endedAt) {
      runtime.nextAt = nextAfter(runtime.nextAt, runtime.job.every, endedAt)
    }
    if (stopped) return
    try {
      db.update(jobExecution)
        .set({ endedAt, result: error === null ? 'succeeded' : 'failed', error })
        .where(eq(jobExecution.id, id))
        .run()
    } catch (thrown) {
      console.error(`[job] could not record how ${runtime.job.name} ended: ${thrown}`)
    }
  }

  function tick() {
    const at = now()
    for (const runtime of runtimes.values()) {
      const { nextAt, job } = runtime
      if (nextAt === null || at < nextAt) continue
      if (runtime.running) {
        runtime.nextAt = nextAfter(nextAt, job.every, at)
        continue
      }
      try {
        runtime.nextAt = new Date(launch(runtime, nextAt).getTime() + job.every)
      } catch (thrown) {
        console.error(`[job] could not start ${job.name}: ${thrown}`)
      }
    }
  }

  function runtimeOf(name: string): JobRuntime {
    const runtime = runtimes.get(name)
    if (!runtime) throw new ORPCError('NOT_FOUND', { message: `no Job is named ${name}` })
    return runtime
  }

  function overview({ job, nextAt, running }: JobRuntime) {
    return {
      name: job.name,
      schedule: { type: 'every', ms: job.every } as const,
      state: running ? ('running' as const) : ('active' as const),
      nextAt,
    }
  }

  const jobLedger: JobLedger = {
    start() {
      db.update(jobExecution)
        .set({ result: 'interrupted' })
        .where(isNull(jobExecution.result))
        .run()
      for (const runtime of runtimes.values()) {
        const startedAt = launch(runtime, now())
        runtime.nextAt = new Date(startedAt.getTime() + runtime.job.every)
      }
      timer = setInterval(tick, TICK_MS)
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
  internalsOf.set(jobLedger, {
    list: () =>
      [...runtimes.values()].map((runtime) => {
        const last = db
          .select({ startedAt: jobExecution.startedAt, result: jobExecution.result })
          .from(jobExecution)
          .where(and(eq(jobExecution.jobName, runtime.job.name), isNotNull(jobExecution.result)))
          .orderBy(desc(jobExecution.id))
          .get()
        return {
          ...overview(runtime),
          last: last?.result ? { startedAt: last.startedAt, result: last.result } : null,
        }
      }),
    show(name) {
      const runtime = runtimeOf(name)
      const { id: _id, jobName: _jobName, ...columns } = getTableColumns(jobExecution)
      const executions = db
        .select(columns)
        .from(jobExecution)
        .where(eq(jobExecution.jobName, name))
        .orderBy(desc(jobExecution.id))
        .limit(SHOWN_JOB_EXECUTIONS)
        .all()
      return { ...overview(runtime), executions }
    },
    run(name) {
      const runtime = runtimeOf(name)
      if (runtime.running) {
        throw new ORPCError('CONFLICT', { message: `${name} is already running` })
      }
      return { name, startedAt: launch(runtime, now()) }
    },
  })
  return jobLedger
}

function nextAfter(from: Date, every: number, at: Date): Date {
  const periods = Math.floor((at.getTime() - from.getTime()) / every) + 1
  return new Date(from.getTime() + periods * every)
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n', 1)[0] ?? text
}
