import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { lintProbes } from './lint-probes'

const repo = join(import.meta.dir, '../..')

// cli・ui・body は Backend の外でも動くので DB に触れず、schema はどこでも import されるので決まったものしか import しない。
function forbiddenImports(domain: string): Record<string, string[]> {
  const db = ['bun:sqlite', 'drizzle-orm', `@monica/${domain}/schema`, `@monica/${domain}/server`]
  return { cli: db, ui: db, body: db, schema: ['bun:sqlite', 'zod', `@monica/${domain}/server`] }
}

type Probe = { path: string; specifiers: string[] }

function probes(): Probe[] {
  const found: Probe[] = []
  for (const manifest of new Bun.Glob('packages/*/package.json').scanSync({ cwd: repo })) {
    const root = dirname(manifest)
    const { exports } = JSON.parse(readFileSync(join(repo, manifest), 'utf8')) as {
      exports: Record<string, string>
    }
    for (const [entry, specifiers] of Object.entries(forbiddenImports(root.split('/')[1]!))) {
      const target = exports[`./${entry}`]
      if (!target) continue
      const path = join(root, target)
      found.push({ path, specifiers })
      // directory の entry は、中の file も同じ境界に入る。
      if (path.endsWith('/index.ts')) {
        found.push({ path: join(dirname(path), 'inner.ts'), specifiers })
      }
    }
  }
  return found
}

async function refusedImports(probed: Probe[]): Promise<Map<string, Set<string>>> {
  const files = Object.fromEntries(
    probed.map(({ path, specifiers }) => {
      const imports = specifiers.map((specifier, i) => `import * as m${i} from '${specifier}'\n`)
      const used = `export const used = [${specifiers.map((_, i) => `m${i}`).join(', ')}]\n`
      return [path, imports.join('') + used]
    }),
  )
  const refused = new Map<string, Set<string>>()
  for (const { filename, code, message } of await lintProbes(files)) {
    const specifier = /^'(.+?)' import is restricted/.exec(message)?.[1]
    if (code !== 'eslint(no-restricted-imports)' || !specifier) continue
    refused.set(filename, (refused.get(filename) ?? new Set()).add(specifier))
  }
  return refused
}

test('every cli, ui, body and schema entry of a package refuses the imports its boundary forbids', async () => {
  const probed = probes()

  const refused = await refusedImports(probed)

  const letThrough = Object.fromEntries(
    probed.flatMap(({ path, specifiers }) => {
      const missed = specifiers.filter((specifier) => !refused.get(path)?.has(specifier))
      return missed.length > 0 ? [[path, missed] as const] : []
    }),
  )
  expect(probed.length).toBeGreaterThan(0)
  expect(letThrough).toEqual({})
})
