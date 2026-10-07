import { useEffect } from 'react'

import { AppShell, type Section } from './components/app-shell.tsx'
import { NoteConflictNotice } from './notes/conflict-notice.tsx'
import { DailyPage } from './pages/daily/index.tsx'
import { EssayEditorPage } from './pages/essays/editor.tsx'
import { EssaysListPage } from './pages/essays/list.tsx'
import { NotFound, NoteRedirect } from './pages/note-redirect.tsx'
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
        ) : route.page === 'essays' ? (
          <EssaysListPage />
        ) : route.page === 'essay' ? (
          <EssayEditorPage id={route.id} />
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
    case 'essays':
    case 'essay':
      return 'essays'
    default:
      return null
  }
}
