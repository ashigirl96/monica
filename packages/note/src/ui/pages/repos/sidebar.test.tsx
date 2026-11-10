import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { RepoSidebar } from './sidebar.tsx'

test('the panel shows after the timeline of Repo Notes', () => {
  const html = renderToStaticMarkup(
    <RepoSidebar
      repoName="acme/app"
      scratchSelected
      notes={[]}
      selectedId={null}
      hasMore={false}
      onLoadMore={() => {}}
      onSelectScratch={() => {}}
      onSelect={() => {}}
      onStar={() => {}}
      onDelete={() => {}}
      panel={<p>dummy</p>}
    />,
  )

  const timeline = html.indexOf('No notes yet')
  expect(timeline).toBeGreaterThan(-1)
  expect(html.indexOf('<p>dummy</p>')).toBeGreaterThan(timeline)
  // 時系列の枠の外に出るので、時系列が長くても欄は左の欄の下に残る。
  expect(html.endsWith('</div><p>dummy</p></div>')).toBe(true)
})
