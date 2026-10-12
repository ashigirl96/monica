import { pushErrorToast, pushInfoToast } from '@monica/ui'
import { atom, type Store } from 'jotai'

import { type BenchItem, type CloseRefusal, closeErrors } from '../contract.ts'
import { describeRefusal } from '../refusal.ts'
import type { TaskClient } from './bench-labels.ts'

type Reasons = CloseRefusal[]

// closing は、close を頼まずに戻るときのために前に覚えた理由を持つ。
export type BenchClose =
  | { phase: 'idle' }
  | { phase: 'closing'; reasons: Reasons | null }
  | { phase: 'refused'; reasons: Reasons }
  | { phase: 'armed'; reasons: Reasons }

export const IDLE: BenchClose = { phase: 'idle' }

// Backend に問い合わせ直さず webview の memory にだけ持つので、再起動の後は空になる（ADR-0036）。
export const benchClosesAtom = atom<ReadonlyMap<string, BenchClose>>(new Map())

export function benchCloseOf(store: Store, runspaceId: string): BenchClose {
  return store.get(benchClosesAtom).get(runspaceId) ?? IDLE
}

export type BenchCloseDeps = { store: Store; client: TaskClient }

export type Shown = {
  reasons: string[] | null
  label: 'Close' | 'Close anyway' | 'Click again to discard changes'
}

// close は準備中の Bench を CONFLICT で断るので、準備中には何も出さない。
export function shownOf(state: BenchClose, bench: BenchItem): Shown | null {
  if (bench.setupState === 'preparing') return null
  switch (state.phase) {
    case 'idle':
      return { reasons: null, label: 'Close' }
    case 'refused':
    case 'armed':
      return {
        reasons: describeRefusal(bench.ref, state.reasons).reasons,
        label: state.phase === 'armed' ? 'Click again to discard changes' : 'Close anyway',
      }
    default:
      return null
  }
}

export async function emptied(deps: BenchCloseDeps, runspaceId: string): Promise<void> {
  const before = benchCloseOf(deps.store, runspaceId)
  if (before.phase === 'closing') return
  put(deps.store, runspaceId, { phase: 'closing', reasons: remembered(before) })
  await close(deps, runspaceId, { force: false })
}

export async function press(deps: BenchCloseDeps, runspaceId: string): Promise<void> {
  const before = benchCloseOf(deps.store, runspaceId)
  switch (before.phase) {
    case 'idle':
      put(deps.store, runspaceId, { phase: 'closing', reasons: null })
      return close(deps, runspaceId, { force: false })
    case 'refused':
      put(deps.store, runspaceId, { phase: 'armed', reasons: before.reasons })
      return
    case 'armed':
      put(deps.store, runspaceId, { phase: 'closing', reasons: before.reasons })
      return close(deps, runspaceId, { force: true })
  }
}

export function disarm(store: Store, runspaceId: string): void {
  const before = benchCloseOf(store, runspaceId)
  if (before.phase === 'armed')
    put(store, runspaceId, { phase: 'refused', reasons: before.reasons })
}

// 閉じた Bench は一覧から消えるまで画面に残るので、close が通っても closing のまま一覧の読み直しを待つ。
export function forgetGone(store: Store, listed: ReadonlyMap<string, unknown>): void {
  store.set(benchClosesAtom, (all) => {
    const kept = new Map([...all].filter(([runspaceId]) => listed.has(runspaceId)))
    return kept.size === all.size ? all : kept
  })
}

function remembered(state: BenchClose): Reasons | null {
  return state.phase === 'idle' ? null : state.reasons
}

function put(store: Store, runspaceId: string, state: BenchClose) {
  store.set(benchClosesAtom, (all) => {
    const next = new Map(all)
    if (state.phase === 'idle') next.delete(runspaceId)
    else next.set(runspaceId, state)
    return next
  })
}

function settle(store: Store, runspaceId: string, reasons: Reasons | null) {
  put(store, runspaceId, reasons ? { phase: 'refused', reasons } : IDLE)
}

// 呼ぶ前に、呼び手が Runspace を closing にしておく。
async function close(
  { store, client }: BenchCloseDeps,
  runspaceId: string,
  { force }: { force: boolean },
): Promise<void> {
  let reasons = remembered(benchCloseOf(store, runspaceId))
  try {
    const bench = (await client.bench.list()).find((b) => b.runspaceId === runspaceId)
    if (!bench || bench.setupState === 'preparing') {
      settle(store, runspaceId, reasons)
      return
    }
    // 強制でない close は理由を取り直すので、前に覚えた理由は捨てる。
    if (!force) reasons = null
    put(store, runspaceId, { phase: 'closing', reasons })
    const { ref, warnings } = await client
      .close({ ref: bench.ref, force: force || undefined })
      .catch((error: unknown) => {
        const refusal = refusedReasons(error)
        if (refusal) reasons = refusal
        return Promise.reject(refusal ? refusalInOneLine(bench.ref, refusal) : error)
      })
    // 応答より先に一覧の読み直しが届いて状態を捨てていれば、消えた Bench の状態を作り直さない。
    if (store.get(benchClosesAtom).has(runspaceId)) {
      put(store, runspaceId, { phase: 'closing', reasons: null })
    }
    pushInfoToast(`closed ${ref}`)
    for (const warning of warnings) pushInfoToast(`warning: ${warning}`)
  } catch (error) {
    settle(store, runspaceId, reasons)
    pushErrorToast(error instanceof Error ? error.message : String(error))
  }
}

function refusalInOneLine(ref: string, reasons: Reasons): Error {
  const refusal = describeRefusal(ref, reasons)
  return new Error(`CLOSE_REFUSED: ${refusal.headline} ${refusal.reasons.join('; ')}`)
}

function refusedReasons(error: unknown): Reasons | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('data' in error)) {
    return null
  }
  if (error.code !== 'CLOSE_REFUSED') return null
  const parsed = closeErrors.CLOSE_REFUSED.data.safeParse(error.data)
  return parsed.success ? parsed.data.reasons : null
}
