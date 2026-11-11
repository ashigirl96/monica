import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ArtifactContent } from './artifact-view.tsx'

const render = (path: string, content: string) =>
  renderToStaticMarkup(<ArtifactContent path={path} content={content} onOpenArtifact={() => {}} />)

test('a relative link to another artifact is a button, and an https link opens in a new Browser Tab', () => {
  const html = render(
    'learning-records/0001-x.md',
    '[用語集](../GLOSSARY.md) and [ky](https://github.com/sindresorhus/ky)',
  )

  expect(html).toMatch(/<button type="button"[^>]*>用語集<\/button>/)
  expect(html).toContain(
    '<a href="https://github.com/sindresorhus/ky" target="_blank" rel="noreferrer">ky</a>',
  )
})

test('a javascript link and a link out of the Study dir show as text', () => {
  const html = render('MISSION.md', '[run](javascript:alert(1)) and [out](../../backend.json)')

  expect(html).not.toContain('<a')
  expect(html).not.toContain('<button')
  expect(html).toContain('run and out')
})

test('a file that is not markdown shows as text in pre', () => {
  const html = render('env/env.sh', '# not a heading <b>\n')

  expect(html).toMatch(/^<pre[^>]*># not a heading &lt;b&gt;\n<\/pre>$/)
})
