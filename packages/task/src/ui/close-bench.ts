import { pushErrorToast, pushInfoToast } from '@tania/ui'
import { useCallback } from 'react'

import { closeErrors } from '../contract.ts'
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

// 同じ Bench の Tab が続けて閉じると workbench は続けて呼ぶので、走っている close に重ねない。
const closingRunspaceIds = new Set<string>()

export async function closeTaskOfBench(client: TaskClient, runspaceId: string): Promise<void> {
  if (closingRunspaceIds.has(runspaceId)) return
  closingRunspaceIds.add(runspaceId)
  try {
    const bench = (await client.bench.list()).find((b) => b.runspaceId === runspaceId)
    // close は準備中の Bench を CONFLICT で断る。
    if (!bench || bench.setupState === 'preparing') return
    const { ref, warnings } = await client
      .close({ ref: bench.ref })
      .catch((error: unknown) => Promise.reject(refusalInOneLine(bench.ref, error)))
    pushInfoToast(`closed ${ref}`)
    for (const warning of warnings) pushInfoToast(`warning: ${warning}`)
  } catch (error) {
    pushErrorToast(error instanceof Error ? error.message : String(error))
  } finally {
    closingRunspaceIds.delete(runspaceId)
  }
}

function refusalInOneLine(ref: string, error: unknown): unknown {
  const reasons = refusedReasons(error)
  if (!reasons) return error
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
