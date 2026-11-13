import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react'

import { useNoteClient } from '../client.ts'
import { navigate, usePathname } from '../router.ts'
import {
  type RemovalScreen,
  removalScreenOf,
  type Route,
  routeOf,
  sameRemovalScreen,
} from '../routes.ts'
import { useAutosaveContext } from './autosave-context.tsx'
import { ListedNotes, type ListedNotesView, openKeyOf } from './listed-notes.ts'
import { emptyView } from './open-note.ts'

export const ListedNotesContext = createContext<ListedNotes | null>(null)

type Held = { screen: RemovalScreen; notes: ListedNotes | null }

/**
 * 今いる画面の `ListedNotes`。画面を描く component は中継の route で一度 unmount されるので、
 * route を描き分けるより上で持ち、別の画面に着いたときだけ取り消しの stack ごと替える。
 */
export function useScreenNotes(route: Route): ListedNotes | null {
  const queryClient = useQueryClient()
  const client = useNoteClient()
  const { queue, setOpenNote } = useAutosaveContext()

  function hold(screen: RemovalScreen): Held {
    if (screen === null) return { screen, notes: null }
    const notes = new ListedNotes(screen, {
      queryClient,
      client,
      saves: queue,
      showOpen: setOpenNote,
      pathname: () => window.location.pathname,
      navigate,
    })
    return { screen, notes }
  }

  const [held, setHeld] = useState(() => hold(removalScreenOf(route, null)))
  const screen = removalScreenOf(route, held.screen)
  const same = sameRemovalScreen(screen, held.screen)
  const next = same ? held : hold(screen)
  if (!same) setHeld(next)
  const { notes } = next
  // 描画の直後、入力が届く前に移る。前の Note の予約先を残す間を作らない。
  useLayoutEffect(() => notes?.present(route))
  useEffect(() => notes?.attach(), [notes])
  return notes
}

export function useListedNotes(kind: ListedNotes['kind']): {
  notes: ListedNotes
  view: ListedNotesView
} {
  const notes = useContext(ListedNotesContext)
  if (notes?.kind !== kind) throw new Error(`useListedNotes('${kind}') is outside its screen`)
  const view = useSyncExternalStore(notes.subscribe, notes.view)
  const key = openKeyOf(routeOf(usePathname()))
  // 上の layout effect が新しい route を開くまでは、前の Note を描かない。
  const open = view.open.key === key ? view.open : emptyView(key, view.open.generation)
  return { notes, view: open === view.open ? view : { ...view, open } }
}
