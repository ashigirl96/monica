import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { StudyClient } from './client.ts'
import { StudyRow } from './new-conversation.tsx'
import { ScreenContext } from './screen.tsx'
import { ShellCommand } from './study-page.tsx'

const ID = 'study-0190abcd-ef01-7000-8000-000000000001'

test('the header shows the shell command with the short id in a button', () => {
  const html = renderToStaticMarkup(<ShellCommand studyId={ID} />)

  expect(html).toStartWith('<button')
  expect(html).toContain('<code')
  expect(html).toContain('monica study shell 0190abcd</code>')
})

const row = (playgroundRemoved: boolean) =>
  renderToStaticMarkup(
    <ScreenContext.Provider
      value={{
        client: {} as StudyClient,
        navigate: () => {},
        spaLinkClick: () => () => {},
        repoCandidates: async () => [],
      }}
    >
      <StudyRow
        study={{
          id: ID,
          missionLine: 'Understand ky',
          firstMessage: null,
          lastActivityAt: new Date(0),
          lastLogLine: null,
          playgroundRemoved,
          repos: [],
        }}
        now={new Date(0)}
      />
    </ScreenContext.Provider>,
  )

test('a row of the list says the Playground is gone only for a Study whose Playground was removed', () => {
  expect(row(true)).toContain('Playground は消えた')
  expect(row(false)).not.toContain('Playground は消えた')
})
