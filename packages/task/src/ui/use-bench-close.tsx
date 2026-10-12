import type { EmptyBenchContent, LastTabClosed } from '@monica/workbench/ui'
import { useAtomValue, useStore } from 'jotai'
import { useCallback, useEffect, useMemo } from 'react'

import type { BenchItem } from '../contract.ts'
import {
  type BenchCloseDeps,
  benchClosesAtom,
  IDLE,
  disarm,
  emptied,
  forgetGone,
  press,
  shownOf,
} from './bench-close.ts'
import type { Benches, TaskClient } from './bench-labels.ts'

export function useBenchClose(
  client: TaskClient | null,
  benches: Benches,
): { onLastTabClosed: LastTabClosed; emptyBenchContent: EmptyBenchContent } {
  const store = useStore()
  const deps = useMemo(() => (client ? { store, client } : null), [store, client])

  useEffect(() => forgetGone(store, benches), [store, benches])

  const onLastTabClosed = useCallback<LastTabClosed>(
    (runspaceId, exitRecorded) => {
      if (deps) void emptied(deps, runspaceId, exitRecorded)
    },
    [deps],
  )
  const emptyBenchContent = useCallback<EmptyBenchContent>(
    (runspaceId) => {
      const bench = benches.get(runspaceId)
      if (!deps || !bench) return null
      return <EmptyBench key={runspaceId} deps={deps} bench={bench} />
    },
    [deps, benches],
  )
  return { onLastTabClosed, emptyBenchContent }
}

function EmptyBench({ deps, bench }: { deps: BenchCloseDeps; bench: BenchItem }) {
  const state = useAtomValue(benchClosesAtom).get(bench.runspaceId) ?? IDLE
  const shown = shownOf(state, bench)
  if (!shown) return null

  return (
    <div className="flex max-w-xl flex-col items-center gap-3">
      {shown.reasons && (
        <ul className="flex flex-col gap-1 text-center text-xs text-foreground/80">
          {shown.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={(event) => {
          // WebKit は押した button に focus を移さないので、blur で取り消せるよう自分で移す。
          event.currentTarget.focus()
          void press(deps, bench.runspaceId)
        }}
        onBlur={() => disarm(deps.store, bench.runspaceId)}
        className="rounded-md bg-red-500/15 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/25"
      >
        {shown.label}
      </button>
    </div>
  )
}
