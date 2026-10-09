import type { EmptyBenchContent } from '@monica/workbench/ui'
import { useAtomValue } from 'jotai'
import { useCallback, useState } from 'react'

import type { BenchItem } from '../contract.ts'
import { describeRefusal } from '../refusal.ts'
import type { Benches, TaskClient } from './bench-labels.ts'
import { closeTaskOfBench, closingRunspaceIdsAtom, refusedReasonsAtom } from './close-bench.ts'

export function useEmptyBenchContent(
  client: TaskClient | null,
  benches: Benches,
): EmptyBenchContent {
  return useCallback(
    (runspaceId: string) => {
      const bench = benches.get(runspaceId)
      if (!client || !bench) return null
      return <EmptyBench key={runspaceId} client={client} bench={bench} />
    },
    [client, benches],
  )
}

function EmptyBench({ client, bench }: { client: TaskClient; bench: BenchItem }) {
  const reasons = useAtomValue(refusedReasonsAtom).get(bench.runspaceId)
  const closing = useAtomValue(closingRunspaceIdsAtom).has(bench.runspaceId)
  const [armed, setArmed] = useState(false)
  // close は準備中の Bench を CONFLICT で断る。
  if (closing || bench.setupState === 'preparing') return null

  return (
    <div className="flex max-w-xl flex-col items-center gap-3">
      {reasons && (
        <ul className="flex flex-col gap-1 text-center text-xs text-foreground/80">
          {describeRefusal(bench.ref, reasons).reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={(event) => {
          if (armed) {
            setArmed(false)
            void closeTaskOfBench(client, bench.runspaceId, { force: true })
            return
          }
          // WebKit は押した button に focus を移さないので、blur で取り消せるよう自分で移す。
          event.currentTarget.focus()
          setArmed(true)
        }}
        onBlur={() => setArmed(false)}
        className="rounded-md bg-red-500/15 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/25"
      >
        {armed ? 'Click again to discard changes' : 'Close anyway'}
      </button>
    </div>
  )
}
