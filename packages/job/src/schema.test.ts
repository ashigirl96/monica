import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { migrations } from '../migrations/index.ts'

test('the latest job snapshot holds only the job tables', async () => {
  const meta = join(migrations.folder, 'meta')
  const latest = readdirSync(meta)
    .filter((name) => name.endsWith('_snapshot.json'))
    .toSorted()
    .at(-1)!
  const snapshot = await Bun.file(join(meta, latest)).json()

  expect(Object.keys(snapshot.tables)).toEqual(['job', 'job_execution'])
})
