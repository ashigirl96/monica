import { useEffect } from 'react'

import { AppShell } from './components/app-shell.tsx'
import type { Section } from './keys.ts'
import { NoteConflictNotice } from './notes/conflict-notice.tsx'
import { RemovalsContext, useScreenRemovals } from './notes/use-removals.ts'
import { DailyPage } from './pages/daily/index.tsx'
import { EssayEditorPage } from './pages/essays/editor.tsx'
import { EssaysListPage } from './pages/essays/list.tsx'
import { NotFound, NoteRedirect } from './pages/note-redirect.tsx'
import { ReposPage } from './pages/repos/index.tsx'
import { navigate, usePathname } from './router.ts'
import { type Route, routeOf, todayPath } from './routes.ts'

export function App() {
  const route = routeOf(usePathname())
  const toToday = route.page === 'today'
  const removals = useScreenRemovals(route)

  useEffect(() => {
    if (toToday) navigate(todayPath(new Date()), { replace: true })
  }, [toToday])

  return (
    <>
      {/* 今日への replace の間も外さない。外すと zen が解ける。 */}
      <AppShell active={sectionOf(route)}>
        <RemovalsContext value={removals}>
          {toToday ? null : route.page === 'daily' || route.page === 'pad' ? (
            <DailyPage date={route.page === 'daily' ? route.date : null} />
          ) : route.page === 'essays' ? (
            <EssaysListPage />
          ) : route.page === 'essay' ? (
            <EssayEditorPage id={route.id} />
          ) : route.page === 'note' ? (
            <NoteRedirect id={route.id} />
          ) : route.page === 'repos' ? (
            <ReposPage repo={null} noteId={null} />
          ) : route.page === 'repo' ? (
            <ReposPage repo={route.repo} noteId={route.noteId} />
          ) : (
            <NotFound />
          )}
        </RemovalsContext>
      </AppShell>
      <NoteConflictNotice />
    </>
  )
}

function sectionOf(route: Route): Section | null {
  switch (route.page) {
    case 'today':
    case 'daily':
    case 'pad':
      return 'daily'
    case 'essays':
    case 'essay':
      return 'essays'
    case 'repos':
    case 'repo':
      return 'repos'
    default:
      return null
  }
}
