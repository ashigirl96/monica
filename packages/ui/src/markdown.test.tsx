import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown.tsx'

test('an image is not loaded and shows its alt and URL as text', () => {
  const html = renderToStaticMarkup(
    <Markdown text="See ![leak](http://127.0.0.1:8123/leak.png?q=secret) here." />,
  )

  expect(html).not.toContain('<img')
  expect(html).toContain('leak')
  expect(html).toContain('http://127.0.0.1:8123/leak.png?q=secret')
})

test('a component the caller passes wins over the default', () => {
  const html = renderToStaticMarkup(
    <Markdown
      text="![cat](https://example.com/cat.png)"
      components={{ img: ({ alt, src }) => <img alt={alt} src={src} /> }}
    />,
  )

  expect(html).toContain('<img alt="cat" src="https://example.com/cat.png"/>')
})

test('a table is wrapped so it scrolls on its own instead of widening the text', () => {
  const html = renderToStaticMarkup(<Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />)

  expect(html).toContain('<div class="typeset-scroll"><table>')
})
