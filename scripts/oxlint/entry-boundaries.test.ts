import { expect, test } from 'bun:test'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = join(import.meta.dir, '../..')

// cli・ui・body は Backend の外でも動くので DB に触れず、schema はどこでも import されるので決まったものしか import しない。
function forbiddenImports(domain: string): Record<string, string[]> {
  const db = ['bun:sqlite', 'drizzle-orm', `@tania/${domain}/schema`, `@tania/${domain}/server`]
  return { cli: db, ui: db, body: db, schema: ['bun:sqlite', 'zod', `@tania/${domain}/server`] }
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

// 設定を読まずに oxlint を当てるので、override の書き方を変えてもこのテストは直さずに済む。
async function refusedImports(probed: Probe[]): Promise<Map<string, Set<string>>> {
  const dir = mkdtempSync(join(tmpdir(), 'tania-entry-boundaries-'))
  try {
    copyFileSync(join(repo, '.oxlintrc.json'), join(dir, '.oxlintrc.json'))
    symlinkSync(join(repo, 'scripts'), join(dir, 'scripts'))
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
    for (const { path, specifiers } of probed) {
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      const imports = specifiers.map((specifier, i) => `import * as m${i} from '${specifier}'\n`)
      const used = `export const used = [${specifiers.map((_, i) => `m${i}`).join(', ')}]\n`
      writeFileSync(join(dir, path), imports.join('') + used)
    }
    const oxlint = Bun.spawn([join(repo, 'node_modules/.bin/oxlint'), '-f', 'json', 'packages'], {
      cwd: dir,
      env: process.env,
      stdout: 'pipe',
    })
    const report = (await new Response(oxlint.stdout).json()) as {
      diagnostics: { filename: string; code: string; message: string }[]
    }
    await oxlint.exited
    const refused = new Map<string, Set<string>>()
    for (const { filename, code, message } of report.diagnostics) {
      const specifier = /^'(.+?)' import is restricted/.exec(message)?.[1]
      if (code !== 'eslint(no-restricted-imports)' || !specifier) continue
      refused.set(filename, (refused.get(filename) ?? new Set()).add(specifier))
    }
    return refused
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
