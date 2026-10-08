import { useEffect } from 'react'

import { AppShell, type Section } from './components/app-shell.tsx'
import { NoteConflictNotice } from './notes/conflict-notice.tsx'
import { DailyPage } from './pages/daily/index.tsx'
import { EssayEditorPage } from './pages/essays/editor.tsx'
import { EssaysListPage } from './pages/essays/list.tsx'
import { EssayRemovalsProvider } from './pages/essays/removals.tsx'
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

  return (
    <>
      {/* 今日への replace の間も外さない。外すと zen が解ける。 */}
      <AppShell active={sectionOf(route)}>
        {toToday ? null : route.page === 'daily' ? (
          <DailyPage date={route.date} />
        ) : route.page === 'essays' || route.page === 'essay' || route.page === 'note' ? (
          // Essay どうしの移り（Note Mention・↗）は `/notes/:id` を通るので、それも同じ位置の provider で囲み、取り消しの stack を保つ。
          <EssayRemovalsProvider>
            {route.page === 'essays' ? (
              <EssaysListPage />
            ) : route.page === 'essay' ? (
              <EssayEditorPage id={route.id} />
            ) : (
              <NoteRedirect id={route.id} />
            )}
          </EssayRemovalsProvider>
        ) : route.page === 'repos' ? (
          <ReposPage repo={null} noteId={null} />
        ) : route.page === 'repo' ? (
          <ReposPage repo={route.repo} noteId={route.noteId} />
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
    case 'today':
    case 'daily':
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
