import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { InputMessage } from './fluid/input-message.tsx'

test('while an answer is coming, the input offers 止める in place of 送る, even with a question typed', () => {
  const html = renderToStaticMarkup(
    <InputMessage
      value="And the low zone?"
      onValueChange={() => {}}
      onSend={() => {}}
      status="streaming"
      onStop={() => {}}
    />,
  )

  expect(html).toContain('aria-label="止める"')
  expect(html).not.toContain('送る')
})
