import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { InputMessage } from './input-message.tsx'

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

test('with only sending held back, the textarea still takes typing and 送る is off', () => {
  const html = renderToStaticMarkup(
    <InputMessage value="next question" onValueChange={() => {}} onSend={() => {}} sendDisabled />,
  )

  expect(html).not.toMatch(/<textarea[^>]*disabled/)
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="送る"/)
})
