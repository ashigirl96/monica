import type { BenchLabel, BenchNote } from '@tania/workbench/ui'

import type { BenchItem } from '../contract.ts'

const NOTES: Record<BenchItem['setupState'], BenchNote | null> = {
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
    note: NOTES[setupState],
  }
}
