import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { App } from './app.tsx'
import { ClientContext, type NoteClient, reach } from './client.ts'
import { AutosaveProvider } from './notes/autosave-context.tsx'
import { createQueryClient } from './query.ts'

export function NotesApp({ client }: { client: NoteClient }) {
  const [queryClient] = useState(createQueryClient)

  useEffect(() => reach.watch(() => client.daily.dates()), [client])

  return (
    <QueryClientProvider client={queryClient}>
      <ClientContext value={client}>
        <AutosaveProvider>
          <ReconnectNotice />
          <App />
        </AutosaveProvider>
      </ClientContext>
    </QueryClientProvider>
  )
}

function ReconnectNotice() {
  const unreachable = useSyncExternalStore(reach.subscribe, reach.isUnreachable)
  if (!unreachable) return null
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 bg-[#fdf3d8] px-3 py-1 text-center text-[13px] text-[#3d2f00]"
    >
      tania に再接続中…
    </div>
  )
}
