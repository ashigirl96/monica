import { EventPublisher } from '@orpc/server'
import type { Db, WorkbenchLedger } from '@tania/workbench/server'

import { type BenchDeps, failInterruptedPreparations } from './bench.ts'
import type { BackgroundSyncError, TaskChange } from './contract.ts'
import { defaultGitHub, type GitHub } from './github.ts'
import { defaultGhq, type Ghq, killSetups } from './prepare.ts'
import { applyRunInvariant, type RunOrigin, refOfRunTask } from './run.ts'
import { SYNC_TIMEOUT_MS, type SyncDeps, syncOpenTasks } from './sync.ts'

export type TaskLedger = {
  events: EventPublisher<{ change: TaskChange }>
  start(): void
  stop(): void
}

type Internals = SyncDeps & BenchDeps & { backgroundSyncError: () => BackgroundSyncError | null }

const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60_000

// TaskLedger の型は events / start / stop だけに保ち、GitHub への接続などの中身は TaskLedger を key にここへ置く。
const internalsOf = new WeakMap<TaskLedger, Internals>()

export function internals(taskLedger: TaskLedger): Internals {
  const found = internalsOf.get(taskLedger)
  if (!found) throw new Error('this TaskLedger was not made by createTaskLedger')
  return found
}

export function createTaskLedger(deps: {
  db: Db
  workbenchLedger: WorkbenchLedger
  home: string
  github?: GitHub
  ghq?: Ghq
}): TaskLedger {
  const { db, workbenchLedger, home, github = defaultGitHub, ghq = defaultGhq } = deps
  const events = new EventPublisher<{ change: TaskChange }>()
  const stopped = new AbortController()
  const syncDeps: SyncDeps = {
    db,
    github,
    publish: (change) => events.publish('change', change),
    signal: (timeoutMs) => AbortSignal.any([AbortSignal.timeout(timeoutMs), stopped.signal]),
    running: new Map(),
  }
  const benchDeps: BenchDeps = {
    db,
    workbenchLedger,
    home,
    ghq,
    publish: syncDeps.publish,
    stopped: stopped.signal,
    preparations: new Map(),
    setups: new Set(),
    closing: new Set(),
  }
  let backgroundSyncError: BackgroundSyncError | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined

  // 表示状態は Run の Agent Session から導くので、Run の Agent Session が変わるたびに Task の変化として知らせる。
  function onAgentSessionChanged(agentSessionId: string) {
    if (stopped.signal.aborted) return
    try {
      applyRunInvariant(db, 'started', agentSessionId)
      const ref = refOfRunTask(db, agentSessionId)
      if (ref) syncDeps.publish({ type: 'task', ref })
    } catch (error) {
      console.error(`[task] could not make a Run of ${agentSessionId}: ${error}`)
    }
  }

  function applyRunInvariantToAll(origin: RunOrigin) {
    if (stopped.signal.aborted) return
    try {
      for (const ref of applyRunInvariant(db, origin)) syncDeps.publish({ type: 'task', ref })
    } catch (error) {
      console.error(`[task] could not make Runs of the Agent Sessions in the Benches: ${error}`)
    }
  }

  // retry と backoff は持たず、次の回がやり直す。
  async function syncInBackground() {
    let failure: string | null
    try {
      const { missing, failures } = await syncOpenTasks(syncDeps, SYNC_TIMEOUT_MS)
      if (missing.length > 0) console.error(`[task] GitHub did not return ${missing.join(', ')}`)
      failure = failures.length > 0 ? failures.join('; ') : null
    } catch (error) {
      failure = String(error)
    }
    if (stopped.signal.aborted) return
    backgroundSyncError = failure === null ? null : { at: new Date(), message: failure }
    if (failure !== null) console.error(`[task] background sync failed: ${failure}`)
  }

  const taskLedger: TaskLedger = {
    events,
    start() {
      failInterruptedPreparations(db)
      // async iterator の購読は溜まった合図を 100 件で捨てるので、listener で受ける。
      // Workbench Ledger は transaction の中でも publish するので、読み直しは commit 後の microtask に回す。
      unsubscribe = workbenchLedger.events.subscribe('change', (change) => {
        if (change.type === 'agentSession') {
          queueMicrotask(() => onAgentSessionChanged(change.sessionId))
        } else if (change.type === 'layout') {
          // 合図はどの Tab が動いたかを持たず、Tab ごと Bench に入った Agent Session は Attach なので、全件に attached で当てる。
          queueMicrotask(() => applyRunInvariantToAll('attached'))
        }
      })
      // commit の後、購読の microtask が走る前に止まった Backend の分は、合図が二度と来ない。
      applyRunInvariantToAll('started')
      void syncInBackground()
      timer = setInterval(() => void syncInBackground(), BACKGROUND_SYNC_INTERVAL_MS)
    },
    stop() {
      unsubscribe?.()
      clearInterval(timer)
      stopped.abort(new Error('the Task Ledger has stopped'))
      killSetups(benchDeps.setups)
    },
  }
  internalsOf.set(taskLedger, {
    ...syncDeps,
    ...benchDeps,
    backgroundSyncError: () => backgroundSyncError,
  })
  return taskLedger
}
