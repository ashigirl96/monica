import { expect, test } from 'bun:test'

import { benchLabel } from './bench-label.ts'

test.each([
  ['preparing', { text: 'preparing', error: false }],
  ['failed', { text: 'setup failed', error: true }],
  ['ready', null],
] as const)(
  "a Bench that is %s is labelled by its Task's Repo and Issue, noted %o",
  (setupState, note) => {
    const bench = { runspaceId: 'rs-1', ref: 'acme/app#12', title: 'Ship it', setupState }

    expect(benchLabel(bench)).toEqual({ repo: 'acme/app', number: 12, title: 'Ship it', note })
  },
)
