import { useBenchLabels, useCloseTaskOfBench, useTabMenuItems } from '@monica/task/ui'
import { Toaster } from '@monica/ui'
import { Workbench } from '@monica/workbench/ui'
import { useMemo } from 'react'

import { useBackend } from './backend-provider.tsx'

export function App() {
  const client = useBackend()
  // oRPC の client は property を読むたびに新しい Proxy を返すので、endpoint ごとに 1 つに固定する。
  const workbench = useMemo(() => client?.workbench ?? null, [client])
  const task = useMemo(() => client?.task ?? null, [client])
  const benchLabelOf = useBenchLabels(task)
  const tabMenuItems = useTabMenuItems(task)
  const closeTaskOfBench = useCloseTaskOfBench(task)

  return (
    <>
      <Workbench
        client={workbench}
        benchLabelOf={benchLabelOf}
        tabMenuItems={tabMenuItems}
        onLastTabClosed={closeTaskOfBench}
      />
      <Toaster />
    </>
  )
}
