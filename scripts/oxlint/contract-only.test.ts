import { afterAll, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const repo = join(import.meta.dir, '../..')

const domains = readdirSync(join(repo, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)

const ocMeta = "import { oc } from '@orpc/contract'\nexport const base = oc.$meta({})\n"
const osMeta = "import { os } from '@orpc/server'\nexport const base = os.$meta({})\n"
const schemaFactory =
  "import { createSchemaFactory } from 'drizzle-zod'\nexport const factory = createSchemaFactory({ coerce: { date: true } })\n"
const both = [
  "import { oc } from '@orpc/contract'",
  "import { createSchemaFactory } from 'drizzle-zod'",
  'export const base = oc.$meta({})',
  'export const factory = createSchemaFactory({ coerce: { date: true } })',
  '',
].join('\n')

const allowed: Record<string, string> = {
  ...Object.fromEntries(domains.map((dir) => [`${dir}/src/contract.ts`, both])),
  'apps/cli/src/forward.ts': both,
}
const refused: Record<string, string> = {
  ...Object.fromEntries(domains.map((dir) => [`${dir}/src/server.ts`, ocMeta])),
  'packages/task/src/ui/contract.ts': ocMeta,
  'apps/cli/src/contract.ts': ocMeta,
  'packages/task/src/router.ts': osMeta,
  ...Object.fromEntries(domains.map((dir) => [`${dir}/src/factory.ts`, schemaFactory])),
  'apps/backend/src/factory.ts': schemaFactory,
}

test('$meta と createSchemaFactory を書けるのは、各 package の contract.ts と、contract の meta を写す apps/cli の forward.ts だけ', async () => {
  const diagnostics = await lintProbes({ ...allowed, ...refused })

  const flagged = new Set(
    diagnostics
      .filter(({ code }) => code === 'monica(contract-only)')
      .map(({ filename }) => filename),
  )
  const paths = [...Object.keys(allowed), ...Object.keys(refused)]
  expect(paths.filter((path) => flagged.has(path))).toEqual(Object.keys(refused))
})
