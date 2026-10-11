import { expect, test } from 'bun:test'

import { formatters } from './cli.ts'

test('list prints each Feature and Caller with its calls, failed calls and the day it was last used', () => {
  const text = formatters.list({
    usages: [
      { feature: 'job.pause', caller: null, ok: 0, failed: 0, lastUsed: null },
      { feature: 'task.run', caller: 'cli', ok: 3, failed: 2, lastUsed: '2026-10-09' },
      { feature: 'chat.ask', caller: 'extension', ok: 12, failed: 0, lastUsed: '2026-10-11' },
    ],
  })

  expect(text).toBe(
    [
      'FEATURE    CALLER     CALLS  FAILED  LAST USED',
      'job.pause  -          0      0       -',
      'task.run   cli        5      2       2026-10-09',
      'chat.ask   extension  12     0       2026-10-11',
    ].join('\n'),
  )
})
