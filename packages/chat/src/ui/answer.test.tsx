import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Answer } from './answer.tsx'

const render = (text: string) => renderToStaticMarkup(<Answer text={text} />)

test('an http or https link opens in a new Browser Tab and shows its host', () => {
  const html = render('[the spec](https://example.com/docs/a) and [old](http://old.example:8080/)')

  expect(html).toContain(
    '<a href="https://example.com/docs/a" target="_blank" rel="noreferrer">the spec</a>',
  )
  expect(html).toContain(
    '<a href="http://old.example:8080/" target="_blank" rel="noreferrer">old</a>',
  )
  expect(html).toContain('example.com</span>')
  expect(html).toContain('old.example:8080</span>')
})

test('a link of any other scheme shows as text', () => {
  const html = render(
    '[run](javascript:alert(1)) [mail](mailto:a@example.com) [here](/relative) [file](file:///etc/hosts)',
  )

  expect(html).not.toContain('<a')
  expect(html).toContain('run')
  expect(html).toContain('mail')
  expect(html).toContain('here')
  expect(html).toContain('file')
})
