import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const probes = {
  'packages/task/src/transaction.ts': 'db.transaction(async (tx) => tx)\n',
  'packages/task/src/open.ts': "reservations.writeOpenTask(1, 'a/b#1', async (tx) => tx)\n",
  'packages/task/src/closed.ts':
    "async function write(tx) { return tx }\nreservations.writeClosedTask(1, 'a/b#1', write)\n",
  'packages/task/src/launch.ts': "reservations.openRunTab(1, 'a/b#1', async (tx) => tx)\n",
  'packages/task/src/sync.ts': "reservations.writeOpenTask(1, 'a/b#1', (tx) => tx)\n",
}

test('transaction と、それを開く task の reservation の method に async 関数を渡すと止まる', async () => {
  const diagnostics = await lintProbes(probes)

  const flagged = diagnostics
    .filter((d) => d.code.includes('sync-transaction'))
    .map((d) => d.filename)
    .toSorted()
  expect(flagged).toEqual([
    'packages/task/src/closed.ts',
    'packages/task/src/launch.ts',
    'packages/task/src/open.ts',
    'packages/task/src/transaction.ts',
  ])
})
