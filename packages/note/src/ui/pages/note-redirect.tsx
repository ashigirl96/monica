import { useEffect, useState } from 'react'

import { useNoteClient } from '../client.ts'
import { useDocumentTitle } from '../document-title.ts'
import { navigate } from '../router.ts'
import { notePagePath } from '../routes.ts'

/**
 * `/notes/{id}` を note の kind に応じた URL へ飛ばす。既存ノート本文の mention href
 * （`/notes/{id}`）が永続化されているため、ルート自体は恒久的に温存してここで振り分ける。
 */
export function NoteRedirect({ id }: { id: string }) {
  const client = useNoteClient()
  const [error, setError] = useState<string | null>(null)
  useDocumentTitle(null)

  useEffect(() => {
    let cancelled = false
    client.get({ id }).then(
      (note) => {
        if (cancelled) return
        const path = notePagePath(note)
        if (path === null) setError('Not found')
        else navigate(path, { replace: true })
      },
      () => {
        if (!cancelled) setError('Note not found')
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, id])

  return <Message>{error ?? 'Opening…'}</Message>
}

export function NotFound() {
  useDocumentTitle(null)
  return <Message>Not found</Message>
}

function Message({ children }: { children: string }) {
  return (
    <div className="notes-screen flex h-dvh items-center justify-center bg-[var(--paper)]">
      <p className="text-sm text-[var(--ink-faint)]">{children}</p>
    </div>
  )
}
