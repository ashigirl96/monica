import { createContext, useContext, useState } from 'react'

import { useNoteClient } from '../client.ts'
import {
  openNoteIdOfPath,
  type RemovalScreen,
  removalScreenOf,
  type Route,
  sameRemovalScreen,
} from '../routes.ts'
import { useAutosaveContext } from './autosave-context.tsx'
import { useForgetNote } from './queries.ts'
import { type RemovableKind, Removals } from './removals.ts'

export const RemovalsContext = createContext<Removals | null>(null)

type Held = { screen: RemovalScreen; removals: Removals | null }

/**
 * 今いる画面の `Removals`。画面を描く component は中継の route で一度 unmount されるので、
 * route を描き分けるより上で持ち、別の画面に着いたときだけ取り消しの stack ごと替える。
 */
export function useScreenRemovals(route: Route): Removals | null {
  const client = useNoteClient()
  const { flush, hasUnsaved, discard } = useAutosaveContext()
  const forgetBody = useForgetNote()

  function hold(screen: RemovalScreen): Held {
    if (screen === null) return { screen, removals: null }
    const removals = new Removals(screen.kind, {
      flush,
      hasUnsaved,
      remove: (id) => client.remove({ id }),
      restore: (id) => client.restore({ id }),
      discard,
      forgetBody,
      // navigate は URL をその場で書き換えるが、prop と effect で写した ref は描画の後まで前の Note を指す。
      openId: () => openNoteIdOfPath(window.location.pathname),
    })
    return { screen, removals }
  }

  const [held, setHeld] = useState(() => hold(removalScreenOf(route, null)))
  const screen = removalScreenOf(route, held.screen)
  if (sameRemovalScreen(screen, held.screen)) return held.removals
  const next = hold(screen)
  setHeld(next)
  return next.removals
}

export function useRemovals(kind: RemovableKind): Removals {
  const removals = useContext(RemovalsContext)
  if (removals?.kind !== kind) throw new Error(`useRemovals('${kind}') is outside its screen`)
  return removals
}
