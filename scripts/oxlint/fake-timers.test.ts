import { afterAll, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const repo = join(import.meta.dir, '../..')

const directories = (root: string) =>
  readdirSync(join(repo, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${root}/${entry.name}`)

const refused: Record<string, string> = {
  ...Object.fromEntries(
    [...directories('packages'), ...directories('apps')].map((dir) => [
      `${dir}/src/probe.test.ts`,
      "import { jest } from 'bun:test'\njest.useFakeTimers()\n",
    ]),
  ),
  'packages/task/src/vi.test.ts': "import { vi } from 'bun:test'\nvi.useFakeTimers()\n",
  'packages/task/src/destructured.test.ts':
    "import { jest } from 'bun:test'\nconst { useFakeTimers } = jest\nuseFakeTimers()\n",
}
const allowed: Record<string, string> = {
  'packages/task/src/allowed.test.ts': [
    "import { jest, setSystemTime, spyOn } from 'bun:test'",
    'jest.setSystemTime(0)',
    'setSystemTime()',
    "spyOn(globalThis, 'setTimeout')",
    '',
  ].join('\n'),
}

test('useFakeTimers は jest でも vi でも、どの package と app のテストでも止まる', async () => {
  const diagnostics = await lintProbes({ ...refused, ...allowed })

  const flagged = new Set(
    diagnostics
      .filter(({ code }) => code === 'eslint(no-restricted-properties)')
      .map(({ filename }) => filename),
  )
  const paths = [...Object.keys(refused), ...Object.keys(allowed)]
  expect(paths.filter((path) => flagged.has(path))).toEqual(Object.keys(refused))
})
