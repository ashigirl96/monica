import { createContext, type ReactNode, useContext } from 'react'

import type { Removals } from '../../notes/removals.ts'
import { useRemovals } from '../../notes/use-removals.ts'

const EssayRemovalsContext = createContext<Removals | null>(null)

/** 取り消しの stack を、一覧と編集を合わせた Essay の画面にいる間だけ持つ。 */
export function EssayRemovalsProvider({ children }: { children: ReactNode }) {
  const removals = useRemovals('essay')
  return <EssayRemovalsContext value={removals}>{children}</EssayRemovalsContext>
}

export function useEssayRemovals(): Removals {
  const removals = useContext(EssayRemovalsContext)
  if (removals === null) throw new Error('useEssayRemovals requires EssayRemovalsProvider')
  return removals
}
