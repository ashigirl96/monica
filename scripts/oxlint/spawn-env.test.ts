import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const refused = {
  'packages/x/src/spawn.ts': "Bun.spawn(['gh'])\n",
  'packages/x/src/spawn-sync.ts': "Bun.spawnSync(['git'])\n",
  'packages/x/src/cmd.ts': "Bun.spawn({ cmd: ['ghq'] })\n",
  'apps/backend/src/b.ts': 'Bun.spawn(cmd, options)\n',
}

const allowed = {
  'packages/x/src/env.ts': "Bun.spawn(['gh'], { env: process.env })\n",
  'packages/x/src/cmd-env.ts': "Bun.spawn({ cmd: ['git'], env })\n",
  'packages/x/src/absolute.ts': "Bun.spawn(['/usr/bin/open'])\n",
  'packages/x/src/a.test.ts': "Bun.spawn(['gh'])\n",
  'packages/x/src/testing.ts': "Bun.spawn(['gh'])\n",
  'packages/x/src/fake-gh.ts': "Bun.spawn(['gh'])\n",
  'apps/cli/src/c.ts': "Bun.spawn(['gh'])\n",
}

test('PATH で実行 file を探す Bun.spawn に env が無ければ、Backend で動くコードでは止まる', async () => {
  const diagnostics = await lintProbes({ ...refused, ...allowed })

  const flagged = diagnostics
    .filter((d) => d.code.includes('spawn-env'))
    .map((d) => d.filename)
    .toSorted()
  expect(flagged).toEqual(Object.keys(refused).toSorted())
})
