import { useEffect } from 'react'

import { AppShell, type Section } from './components/app-shell.tsx'
import { NoteConflictNotice } from './notes/conflict-notice.tsx'
import { DailyPage } from './pages/daily/index.tsx'
import { NotFound, NoteRedirect } from './pages/note-redirect.tsx'
import { ReposPage } from './pages/repos/index.tsx'
import { navigate, usePathname } from './router.ts'
import { type Route, routeOf, todayPath } from './routes.ts'

export function App() {
  const route = routeOf(usePathname())
  const toToday = route.page === 'today'

  useEffect(() => {
    if (toToday) navigate(todayPath(new Date()), { replace: true })
  }, [toToday])

  if (route.page === 'today') return null
  return (
    <>
      <AppShell active={sectionOf(route)}>
        {route.page === 'daily' ? (
          <DailyPage date={route.date} />
        ) : route.page === 'repos' ? (
          <ReposPage repo={null} noteId={null} />
        ) : route.page === 'repo' ? (
          <ReposPage repo={route.repo} noteId={route.noteId} />
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

function sectionOf(route: Route): Section | null {
  switch (route.page) {
    case 'daily':
      return 'daily'
    case 'repos':
    case 'repo':
      return 'repos'
    default:
      return null
  }
}
