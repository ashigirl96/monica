import type { BenchLabel } from '@monica/workbench/ui'

import type { BenchItem } from '../contract.ts'

// ref は `owner/repo#n` で、repo の名前は `#` を含まない。
export function benchLabel({ ref, title }: BenchItem): BenchLabel {
  const hash = ref.lastIndexOf('#')
  return {
    repo: ref.slice(0, hash),
    number: Number(ref.slice(hash + 1)),
    title,
  }
}
