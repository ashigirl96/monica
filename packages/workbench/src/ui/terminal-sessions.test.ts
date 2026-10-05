import { expect, test } from 'bun:test'

import { canAttach } from './terminal-sessions.ts'

test.each([
  { status: 'starting', attach: false },
  { status: 'running', attach: true },
  { status: 'exited', attach: false },
  { status: 'lost', attach: false },
  { status: 'failed', attach: false },
  { status: undefined, attach: true },
] as const)('a pane attaches to a $status Terminal Session: $attach', ({ status, attach }) => {
  expect(canAttach(status)).toBe(attach)
})
