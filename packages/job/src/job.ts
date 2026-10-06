import { rmSync } from 'node:fs'

import { ORPCError } from '@orpc/server'
import type { Subprocess } from 'bun'
import type { Cron } from 'croner'
import { and, asc, desc, eq, getTableColumns, isNotNull, isNull, lt } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { killGroups, logDirOf, logPathOf, type Outcome, runCommand } from './command.ts'
import type {
  AddOutput,
  JobItem,
  PauseOutput,
  RemoveOutput,
  ResumeOutput,
  RunOutput,
  Schedule,
  ShowOutput,
} from './contract.ts'
import { job, jobExecution } from './schema.ts'
import { cronOf, parseCwd, parseSchedule, parseTimeout, type UserJob } from './user-job.ts'

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
  add(input: AddInput): AddOutput
  remove(name: string): RemoveOutput
  pause(name: string): PauseOutput
  resume(name: string): ResumeOutput
}

type AddInput = { name: string; schedule: string; command: string; cwd?: string; timeout?: string }

type JobRuntime = { nextAt: Date | null; running: boolean } & (
  | { kind: 'system'; job: SystemJob }
  | { kind: 'user'; job: UserJob; cron: Cron }
)

type UserRuntime = Extract<JobRuntime, { kind: 'user' }>

const TICK_MS = 30_000
// これより遅れて気づいた予定は、Backend が凍っていた（sleep）間に来たものとみなす。
const LATE_MS = 2 * TICK_MS
const SUCCEEDED: Outcome = { result: 'succeeded', exitCode: null, error: null }
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
  home: string
  systemJobs: SystemJob[]
  now?: () => Date
}): JobLedger {
  const { db, home, systemJobs, now = () => new Date() } = deps
  const runtimes = new Map<string, JobRuntime>()
  for (const systemJob of systemJobs) {
    if (!systemJob.name.includes('.')) {
      throw new Error(`the system Job ${systemJob.name} needs a . in its name`)
    }
    if (runtimes.has(systemJob.name)) throw new Error(`two system Jobs are named ${systemJob.name}`)
    runtimes.set(systemJob.name, { kind: 'system', job: systemJob, nextAt: null, running: false })
  }
  for (const userJob of db.select().from(job).orderBy(asc(job.addedAt)).all()) {
    runtimes.set(userJob.name, createUserRuntime(userJob, cronOf(userJob.schedule)))
  }
  const children = new Set<Subprocess>()
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  // 古い行は足す側で消すので、走っている回を含めても 100 件を超えない。
  function launch(runtime: JobRuntime, scheduledAt: Date): Date {
    const { name } = runtime.job
    const startedAt = now()
    const { logPath, run } = executionOf(runtime, startedAt)
    const { id, dropped } = db.transaction((tx) => {
      const inserted = tx
        .insert(jobExecution)
        .values({ jobName: name, scheduledAt, startedAt, logPath })
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
      const droppedRows = oldestKept
        ? tx
            .delete(jobExecution)
            .where(and(eq(jobExecution.jobName, name), lt(jobExecution.id, oldestKept.id)))
            .returning({ logPath: jobExecution.logPath })
            .all()
        : []
      return { id: inserted.id, dropped: droppedRows }
    })
    for (const { logPath: droppedLog } of dropped) {
      if (!droppedLog) continue
      try {
        rmSync(droppedLog, { force: true })
      } catch (thrown) {
        console.error(`[job] could not remove the log ${droppedLog}: ${thrown}`)
      }
    }
    runtime.running = true
    void runAndRecord(runtime, id, run)
    return startedAt
  }

  function executionOf(
    runtime: JobRuntime,
    startedAt: Date,
  ): { logPath: string | null; run: () => Promise<Outcome> } {
    if (runtime.kind === 'system') {
      return { logPath: null, run: () => runtime.job.run().then(() => SUCCEEDED) }
    }
    const logPath = logPathOf(home, runtime.job.name, startedAt)
    return { logPath, run: () => runCommand(runtime.job, logPath, children) }
  }

  async function runAndRecord(runtime: JobRuntime, id: number, run: () => Promise<Outcome>) {
    const outcome = await run().catch((thrown: unknown): Outcome => ({
      result: 'failed',
      exitCode: null,
      error: firstLine(thrown),
    }))
    const endedAt = now()
    runtime.running = false
    // tick の前に終わっても、予定の時刻には走っていたので、その回は飛ばす。
    if (runtime.nextAt && runtime.nextAt <= endedAt) {
      runtime.nextAt = nextAfterSkipping(runtime, runtime.nextAt, endedAt)
    }
    if (stopped) return
    try {
      db.update(jobExecution)
        .set({ endedAt, ...outcome })
        .where(eq(jobExecution.id, id))
        .run()
    } catch (thrown) {
      console.error(`[job] could not record how ${runtime.job.name} ended: ${thrown}`)
    }
  }

  function tick() {
    const at = now()
    for (const runtime of runtimes.values()) {
      const { nextAt } = runtime
      if (nextAt === null || at < nextAt) continue
      if (runtime.running || isLate(runtime, nextAt, at)) {
        runtime.nextAt = nextAfterSkipping(runtime, nextAt, at)
        continue
      }
      try {
        runtime.nextAt = nextAfterLaunch(runtime, launch(runtime, nextAt))
      } catch (thrown) {
        console.error(`[job] could not start ${runtime.job.name}: ${thrown}`)
      }
    }
  }

  function runtimeOf(name: string): JobRuntime {
    const runtime = runtimes.get(name)
    if (!runtime) throw new ORPCError('NOT_FOUND', { message: `no Job is named ${name}` })
    return runtime
  }

  function userRuntimeOf(name: string, refused: string): UserRuntime {
    const runtime = runtimeOf(name)
    if (runtime.kind === 'system') {
      throw new ORPCError('BAD_REQUEST', {
        message: `${name} is a system Job, so it cannot be ${refused}`,
      })
    }
    return runtime
  }

  function setPaused(runtime: UserRuntime, paused: boolean) {
    runtime.job = db
      .update(job)
      .set({ paused })
      .where(eq(job.name, runtime.job.name))
      .returning()
      .get()!
    runtime.nextAt = paused ? null : runtime.cron.nextRun(now())
  }

  function overview(runtime: JobRuntime) {
    return {
      name: runtime.job.name,
      schedule: scheduleOf(runtime),
      state: runtime.running
        ? ('running' as const)
        : runtime.kind === 'user' && runtime.job.paused
          ? ('paused' as const)
          : ('active' as const),
      nextAt: runtime.nextAt,
    }
  }

  const jobLedger: JobLedger = {
    start() {
      db.update(jobExecution)
        .set({ result: 'interrupted' })
        .where(isNull(jobExecution.result))
        .run()
      for (const runtime of runtimes.values()) {
        if (runtime.kind === 'system') {
          runtime.nextAt = nextAfterLaunch(runtime, launch(runtime, now()))
        } else if (!runtime.job.paused) {
          runtime.nextAt = runtime.cron.nextRun(now())
        }
      }
      timer = setInterval(tick, TICK_MS)
    },
    stop() {
      stopped = true
      clearInterval(timer)
      killGroups(children)
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
      const shell =
        runtime.kind === 'user'
          ? { command: runtime.job.command, cwd: runtime.job.cwd, timeoutMs: runtime.job.timeoutMs }
          : null
      return { ...overview(runtime), shell, executions }
    },
    run(name) {
      const runtime = runtimeOf(name)
      if (runtime.running) {
        throw new ORPCError('CONFLICT', { message: `${name} is already running` })
      }
      return { name, startedAt: launch(runtime, now()) }
    },
    add(input) {
      if (runtimes.has(input.name)) {
        throw new ORPCError('CONFLICT', {
          message: `a Job is already named ${input.name}; remove it first to change it`,
        })
      }
      const cron = parseSchedule(input.schedule)
      const userJob = db
        .insert(job)
        .values({
          name: input.name,
          schedule: input.schedule,
          command: input.command,
          cwd: parseCwd(input.cwd),
          timeoutMs: parseTimeout(input.timeout),
          addedAt: now(),
        })
        .returning()
        .get()
      const runtime = createUserRuntime(userJob, cron)
      runtime.nextAt = cron.nextRun(now())
      runtimes.set(userJob.name, runtime)
      return { name: userJob.name, nextAt: runtime.nextAt }
    },
    remove(name) {
      const runtime = userRuntimeOf(name, 'removed')
      if (runtime.running) {
        throw new ORPCError('CONFLICT', { message: `${name} is running; remove it once it ends` })
      }
      db.transaction((tx) => {
        tx.delete(jobExecution).where(eq(jobExecution.jobName, name)).run()
        tx.delete(job).where(eq(job.name, name)).run()
      })
      runtimes.delete(name)
      try {
        rmSync(logDirOf(home, name), { recursive: true, force: true })
      } catch (thrown) {
        console.error(`[job] could not remove the logs of ${name}: ${thrown}`)
      }
      return { name }
    },
    pause(name) {
      setPaused(userRuntimeOf(name, 'paused'), true)
      return { name }
    },
    resume(name) {
      const runtime = userRuntimeOf(name, 'resumed')
      setPaused(runtime, false)
      return { name, nextAt: runtime.nextAt }
    },
  })
  return jobLedger
}

function createUserRuntime(userJob: UserJob, cron: Cron): UserRuntime {
  return { kind: 'user', job: userJob, cron, nextAt: null, running: false }
}

function scheduleOf(runtime: JobRuntime): Schedule {
  return runtime.kind === 'system'
    ? { type: 'every', ms: runtime.job.every }
    : { type: 'cron', expression: runtime.job.schedule }
}

// system の Job は sleep 明けにも 1 回走らせ、ユーザーの Job は深夜の回を朝に走らせない。
function isLate(runtime: JobRuntime, nextAt: Date, at: Date): boolean {
  return runtime.kind === 'user' && at.getTime() - nextAt.getTime() > LATE_MS
}

function nextAfterLaunch(runtime: JobRuntime, startedAt: Date): Date | null {
  return runtime.kind === 'system'
    ? new Date(startedAt.getTime() + runtime.job.every)
    : runtime.cron.nextRun(startedAt)
}

function nextAfterSkipping(runtime: JobRuntime, from: Date, at: Date): Date | null {
  if (runtime.kind === 'user') return runtime.cron.nextRun(at)
  const { every } = runtime.job
  const periods = Math.floor((at.getTime() - from.getTime()) / every) + 1
  return new Date(from.getTime() + periods * every)
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n', 1)[0] ?? text
}
