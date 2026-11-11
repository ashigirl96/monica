import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraduationCap } from 'lucide-react'
import type { ReactNode } from 'react'

import { StudyIdSchema } from '../contract.ts'
import { NewConversation } from './new-conversation.tsx'
import { RepoStudies } from './repo-links.tsx'
import { ScreenContext, type ScreenDeps } from './screen.tsx'
import { NoStudyPage, StudyPage } from './study-page.tsx'

type Route = { page: 'new' } | { page: 'study'; id: string } | { page: 'not-found' }

function routeOf(pathname: string): Route | null {
  if (pathname === '/studies') return { page: 'new' }
  if (!pathname.startsWith('/studies/')) return null
  const id = pathname.slice('/studies/'.length)
  return StudyIdSchema.safeParse(id).success ? { page: 'study', id } : { page: 'not-found' }
}

function pageOf(route: Route) {
  switch (route.page) {
    case 'new':
      return <NewConversation />
    case 'study':
      return <StudyPage key={route.id} id={route.id} />
    case 'not-found':
      return <NoStudyPage />
  }
}

export function createStudySlots(deps: ScreenDeps) {
  // note の QueryClientProvider の下に描かれても、note の cache と混ざらないよう自分のを持つ。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: true, retry: false } },
  })
  const provide = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <ScreenContext value={deps}>{children}</ScreenContext>
    </QueryClientProvider>
  )
  return {
    slotPage: (pathname: string) => {
      const route = routeOf(pathname)
      return route === null ? null : provide(pageOf(route))
    },
    repoPanel: (repo: string) => provide(<RepoStudies repo={repo} />),
    railItem: {
      to: '/studies',
      label: 'Study',
      icon: <GraduationCap className="size-[18px]" strokeWidth={1.8} />,
    },
  }
}
