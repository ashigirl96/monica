import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraduationCap } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

import { StudyIdSchema } from '../contract.ts'
import type { StudyClient } from './client.ts'
import { NewConversation } from './new-conversation.tsx'
import { type Navigation, ScreenContext } from './screen.tsx'
import { NoStudyPage, StudyPage } from './study-page.tsx'

/** note の SlotPage と同じ形。study は note を import しないので自分で書く。 */
export type SlotPage = (pathname: string) => ReactElement | null
/** note の RailItem と同じ形。 */
export type RailItem = { to: string; label: string; icon: ReactNode }

type Route = { page: 'new' } | { page: 'study'; id: string } | { page: 'not-found' }

function routeOf(pathname: string): Route | null {
  if (pathname === '/studies' || pathname === '/studies/') return { page: 'new' }
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

export function createStudySlots({ client, ...navigation }: Navigation & { client: StudyClient }): {
  slotPage: SlotPage
  railItem: RailItem
} {
  // note の QueryClientProvider の下に描かれても、note の cache と混ざらないよう自分のを持つ。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: true, retry: false } },
  })
  const deps = { client, ...navigation }
  return {
    slotPage: (pathname) => {
      const route = routeOf(pathname)
      if (route === null) return null
      return (
        <QueryClientProvider client={queryClient}>
          <ScreenContext value={deps}>{pageOf(route)}</ScreenContext>
        </QueryClientProvider>
      )
    },
    railItem: {
      to: '/studies',
      label: 'Study',
      icon: <GraduationCap className="size-[18px]" strokeWidth={1.8} />,
    },
  }
}
