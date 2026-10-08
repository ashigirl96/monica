import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { lintProbes } from './lint-probes'

const repo = join(import.meta.dir, '../..')
const probe = 'export const id = chrome.runtime.id\n'

// chat の ui は Chrome Extension の side panel でだけ動く（ADR-0029）。chat の package がまだ無くても例外の path を見る。
const domains = [
  ...new Set([
    ...readdirSync(join(repo, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
    'chat',
  ]),
]
const allowed = ['apps/extension/src/probe.ts', 'packages/chat/src/ui/probe.ts']
const refused = [
  'apps/web/src/probe.ts',
  'apps/desktop/src/probe.ts',
  'apps/backend/src/probe.ts',
  ...domains.map((domain) => `packages/${domain}/src/probe.ts`),
  ...domains
    .filter((domain) => domain !== 'chat')
    .map((domain) => `packages/${domain}/src/ui/probe.ts`),
]

test('chrome の global を使えるのは apps/extension と chat の ui だけ', async () => {
  const diagnostics = await lintProbes(
    Object.fromEntries([...allowed, ...refused].map((path) => [path, probe])),
  )

  const flagged = new Set(
    diagnostics
      .filter(({ code }) => code === 'eslint(no-restricted-globals)')
      .map(({ filename }) => filename),
  )
  expect([...allowed, ...refused].filter((path) => flagged.has(path))).toEqual(refused)
})
