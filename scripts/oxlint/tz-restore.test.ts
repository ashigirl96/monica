import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const tz = 'const tz = process.env.TZ\n'
const refused: Record<string, string> = {
  'packages/usage/src/undefined.test.ts': 'process.env.TZ = undefined\n',
  'packages/usage/src/saved.test.ts': `${tz}process.env.TZ = tz\n`,
  'packages/usage/src/delete.test.ts': 'delete process.env.TZ\n',
  'packages/usage/src/delete-computed.test.ts': "delete process.env['TZ']\n",
}
const allowed: Record<string, string> = {
  'packages/usage/src/literal.test.ts': "process.env.TZ = 'Asia/Tokyo'\n",
  'packages/usage/src/fallback.test.ts': `${tz}process.env.TZ = tz ?? 'UTC'\n`,
}

test('process.env.TZ を delete するか、文字列と決まらない値を代入すると止まる', async () => {
  const diagnostics = await lintProbes({ ...refused, ...allowed })

  const flagged = new Set(
    diagnostics.filter(({ code }) => code === 'monica(tz-restore)').map(({ filename }) => filename),
  )
  const paths = [...Object.keys(refused), ...Object.keys(allowed)]
  expect(paths.filter((path) => flagged.has(path))).toEqual(Object.keys(refused))
})
