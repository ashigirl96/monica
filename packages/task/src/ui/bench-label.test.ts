import { expect, test } from 'bun:test'

import { benchLabel } from './bench-label.ts'

test("a Bench is labelled by its Task's Repo and Issue", () => {
  const bench = { runspaceId: 'rs-1', ref: 'acme/app#12', title: 'Ship it' }

  expect(benchLabel(bench)).toEqual({ repo: 'acme/app', number: 12, title: 'Ship it' })
})
