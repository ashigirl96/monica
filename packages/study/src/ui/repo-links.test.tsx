import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyClient } from './client.ts'
import { RepoStudiesList } from './repo-links.tsx'
import { ScreenContext } from './screen.tsx'

const deps = {
  client: {} as StudyClient,
  repoCandidates: async () => [],
  navigate: () => {},
  spaLinkClick: () => () => {},
}

test('the Study panel of a Repo has a heading and a link to each Study, named by its Mission or faintly by its first message', () => {
  const now = new Date(2026, 10, 11, 12, 0)
  const html = renderToStaticMarkup(
    <ScreenContext value={deps}>
      <RepoStudiesList
        now={now}
        studies={[
          {
            id: 'study-1',
            missionLine: 'Understand ky',
            firstMessage: 'hi',
            lastActivityAt: new Date(2026, 10, 11, 9, 5),
          },
          {
            id: 'study-2',
            missionLine: null,
            firstMessage: 'read hono',
            lastActivityAt: new Date(2026, 10, 1),
          },
        ]}
      />
    </ScreenContext>,
  )

  expect(html).toContain('>Study</h2>')
  expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
    '/studies/study-1',
    '/studies/study-2',
  ])
  expect(html).toContain('>Understand ky</span>')
  expect(html).toContain('09:05')
  expect(html).toMatch(/text-muted-foreground[^"]*">read hono<\/span>/)
  expect(html).toContain('2026-11-01')
})
