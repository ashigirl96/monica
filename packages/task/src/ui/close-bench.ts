import { pushErrorToast, pushInfoToast } from '@monica/ui'
import { atom, getDefaultStore } from 'jotai'
import { useCallback } from 'react'

import { type CloseRefusal, closeErrors } from '../contract.ts'
import { describeRefusal } from '../refusal.ts'
import type { TaskClient } from './bench-labels.ts'

export function useCloseTaskOfBench(client: TaskClient | null): (runspaceId: string) => void {
  return useCallback(
    (runspaceId: string) => {
      if (client) void closeTaskOfBench(client, runspaceId)
    },
    [client],
  )
}

// Backend に問い合わせ直さず webview の memory にだけ持つので、再起動の後は空になる（ADR-0036）。
export const refusedReasonsAtom = atom<ReadonlyMap<string, CloseRefusal[]>>(new Map())

// 同じ Bench の Tab が続けて閉じると workbench は続けて呼ぶので、走っている close に重ねない。
export const closingRunspaceIdsAtom = atom<ReadonlySet<string>>(new Set<string>())

export async function closeTaskOfBench(
  client: TaskClient,
  runspaceId: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const store = getDefaultStore()
  if (store.get(closingRunspaceIdsAtom).has(runspaceId)) return
  store.set(closingRunspaceIdsAtom, (ids) => new Set(ids).add(runspaceId))
  // 強制でない close は理由を取り直すので、前に覚えた理由は捨てる。
  if (!force) forgetReasons(runspaceId)
  let closed = false
  try {
    const bench = (await client.bench.list()).find((b) => b.runspaceId === runspaceId)
    // close は準備中の Bench を CONFLICT で断る。
    if (!bench || bench.setupState === 'preparing') return
    const { ref, warnings } = await client
      .close({ ref: bench.ref, force: force || undefined })
      .catch((error: unknown) => Promise.reject(refused(runspaceId, bench.ref, error)))
    closed = true
    forgetReasons(runspaceId)
    pushInfoToast(`closed ${ref}`)
    for (const warning of warnings) pushInfoToast(`warning: ${warning}`)
  } catch (error) {
    pushErrorToast(error instanceof Error ? error.message : String(error))
  } finally {
    // 閉じた Bench は一覧から消えるまで画面に残るので、close の最中のままにして「Close anyway」を出さない。
    if (!closed) store.set(closingRunspaceIdsAtom, (ids) => without(ids, runspaceId))
  }
}

function without(ids: ReadonlySet<string>, runspaceId: string): ReadonlySet<string> {
  return new Set([...ids].filter((id) => id !== runspaceId))
}

function forgetReasons(runspaceId: string) {
  getDefaultStore().set(refusedReasonsAtom, (all) => {
    if (!all.has(runspaceId)) return all
    const rest = new Map(all)
    rest.delete(runspaceId)
    return rest
  })
}

// CLOSE_REFUSED なら理由を Bench ごとに覚え、toast に出す 1 行の error にする。
function refused(runspaceId: string, ref: string, error: unknown): unknown {
  const reasons = refusedReasons(error)
  if (!reasons) return error
  getDefaultStore().set(refusedReasonsAtom, (all) => new Map(all).set(runspaceId, reasons))
  return refusalInOneLine(ref, reasons)
}

function refusalInOneLine(ref: string, reasons: CloseRefusal[]): Error {
  const refusal = describeRefusal(ref, reasons)
  return new Error(`CLOSE_REFUSED: ${refusal.headline} ${refusal.reasons.join('; ')}`)
}

function refusedReasons(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('data' in error)) {
    return null
  }
  if (error.code !== 'CLOSE_REFUSED') return null
  const parsed = closeErrors.CLOSE_REFUSED.data.safeParse(error.data)
  return parsed.success ? parsed.data.reasons : null
}
