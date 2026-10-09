import { useState } from 'react'

import { useNoteClient } from '../client.ts'
import { openNoteIdOfPath } from '../routes.ts'
import { useAutosaveContext } from './autosave-context.tsx'
import { useForgetNote } from './queries.ts'
import { type RemovableKind, Removals } from './removals.ts'

/** 呼んだ component の寿命の間だけ持つ `Removals`。取り消しの stack も一緒に捨てる。 */
export function useRemovals(kind: RemovableKind): Removals {
  const client = useNoteClient()
  const { flush, hasUnsaved, discard } = useAutosaveContext()
  const forgetBody = useForgetNote()
  const [removals] = useState(
    () =>
      new Removals(kind, {
        flush,
        hasUnsaved,
        remove: (id) => client.remove({ id }),
        restore: (id) => client.restore({ id }),
        discard,
        forgetBody,
        // navigate は URL をその場で書き換えるが、prop と effect で写した ref は描画の後まで前の Note を指す。
        openId: () => openNoteIdOfPath(window.location.pathname),
      }),
  )
  return removals
}
