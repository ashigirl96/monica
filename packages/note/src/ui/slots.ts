import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import { routeOf } from './routes.ts'

/** note の道筋に無い pathname の画面。描かない pathname には null を返す。 */
export type SlotPage = (pathname: string) => ReactElement | null
/** rail の Repo の下に足す項目。⌃4 で開く。 */
export type RailItem = { to: string; label: string; icon: ReactNode }
/** Repo の画面の左の欄で、Repo Note の時系列の下に描く欄。repo は URL の `owner/repo`。 */
export type RepoPanel = (repo: string) => ReactNode

export type Slots = { slotPage?: SlotPage; railItem?: RailItem; repoPanel?: RepoPanel }

export const SlotsContext = createContext<Slots>({})

export function useSlots(): Slots {
  return useContext(SlotsContext)
}

/** note の道筋を先に引くので、slot は note の画面を覆えない。 */
export function slotPageOf(pathname: string, slotPage: SlotPage | undefined): ReactElement | null {
  if (routeOf(pathname).page !== 'not-found') return null
  return slotPage?.(pathname) ?? null
}
