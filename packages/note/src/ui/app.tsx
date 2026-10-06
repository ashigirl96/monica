import { useEffect } from 'react'

import { AppShell } from './components/app-shell.tsx'
import { NoteConflictNotice } from './notes/conflict-notice.tsx'
import { DailyPage } from './pages/daily/index.tsx'
import { NotFound, NoteRedirect } from './pages/note-redirect.tsx'
import { navigate, usePathname } from './router.ts'
import { routeOf, todayPath } from './routes.ts'

export function App() {
  const route = routeOf(usePathname())
  const toToday = route.page === 'today'

  useEffect(() => {
    if (toToday) navigate(todayPath(new Date()), { replace: true })
  }, [toToday])

  if (route.page === 'today') return null
  return (
    <>
      <AppShell active={route.page === 'daily' ? 'daily' : null}>
        {route.page === 'daily' ? (
          <DailyPage date={route.date} />
        ) : route.page === 'note' ? (
          <NoteRedirect id={route.id} />
        ) : (
          <NotFound />
        )}
      </AppShell>
      <NoteConflictNotice />
    </>
  )
}
