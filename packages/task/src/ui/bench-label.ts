import type { BenchLabel, BenchSetup } from '@monica/workbench/ui'

import type { BenchItem } from '../contract.ts'

const SETUPS: Record<BenchItem['setupState'], BenchSetup | null> = {
  preparing: { text: 'preparing', error: false },
  failed: { text: 'setup failed', error: true },
  ready: null,
}

// ref は `owner/repo#n` で、repo の名前は `#` を含まない。
export function benchLabel({ ref, title, setupState }: BenchItem): BenchLabel {
  const hash = ref.lastIndexOf('#')
  return {
    repo: ref.slice(0, hash),
    number: Number(ref.slice(hash + 1)),
    title,
    setup: SETUPS[setupState],
  }
}
