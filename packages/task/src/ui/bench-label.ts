import type { BenchItem } from '../contract.ts'
import { taskLabel } from '../label.ts'

const NOTES = { preparing: 'preparing', failed: 'setup failed', ready: null } as const

export function benchLabel({ ref, title, setupState }: BenchItem) {
  return { name: taskLabel(ref, title), note: NOTES[setupState] }
}
