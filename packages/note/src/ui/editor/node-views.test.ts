import { expect, test } from 'bun:test'

import { isOpenableHref } from './node-views.ts'

const BASE = 'http://tania.localhost:19380/daily/2026-10-06'

test.each([
  'https://example.com/a',
  'http://localhost:3000',
  '/notes/note-3',
  'mailto:me@example.com',
])('%s は開ける', (href) => {
  expect(isOpenableHref(href, BASE)).toBe(true)
})

test.each([
  'javascript:alert(1)',
  ' JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
])('%s は開かない', (href) => {
  expect(isOpenableHref(href, BASE)).toBe(false)
})
