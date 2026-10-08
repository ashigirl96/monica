import type { BenchLabelOf } from '@monica/workbench/ui'
import type { ContractRouterClient } from '@orpc/contract'
import { useCallback, useEffect, useState } from 'react'

import type { BenchItem, contract } from '../contract.ts'
import { benchLabel } from './bench-label.ts'

export type TaskClient = ContractRouterClient<typeof contract>

export function useBenchLabels(client: TaskClient | null): BenchLabelOf {
  const [benches, setBenches] = useState<ReadonlyMap<string, BenchItem>>(new Map())

  // Backend が立ち直ると endpoint ごと替わり、前の購読は届かなくなるので、client ごとに張り直す。
  // DB は同じなので、新しい一覧が届くまで前のラベルを出しておく。
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    let reloading = Promise.resolve()
    // 応答が前後して古い一覧で上書きしないよう、読み直しは 1 本ずつ流す。
    const reload = () => {
      reloading = reloading
        .then(async () => {
          const listed = await client.bench.list(undefined, { signal: controller.signal })
          setBenches(new Map(listed.map((bench) => [bench.runspaceId, bench])))
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) console.warn('bench list reload failed:', error)
        })
    }
    void (async () => {
      try {
        // 先に購読してから読むので、読んだ後の変更を取りこぼさない。title は sync でも変わる。
        const changes = await client.changes(undefined, { signal: controller.signal })
        reload()
        for await (const _ of changes) reload()
      } catch (error) {
        if (!controller.signal.aborted) console.error('task.changes ended', error)
      }
    })()
    return () => controller.abort()
  }, [client])

  return useCallback(
    (runspaceId: string) => {
      const bench = benches.get(runspaceId)
      return bench ? benchLabel(bench) : null
    },
    [benches],
  )
}
