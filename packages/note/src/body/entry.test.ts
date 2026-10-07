import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

// lint は直接の import しか見ないので、contract のような内側の module を経た import をここで拾う。
function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (!path.startsWith('.')) packages.add(path)
      else if (/\.tsx?$/.test(path)) visit(Bun.resolveSync(path, dirname(file)))
    }
  }
  visit(entry)
  return { files, packages }
}

test('nothing the body entry reaches touches the database', () => {
  const { files, packages } = reachable(join(import.meta.dir, 'index.ts'))

  expect([...files].filter((file) => /\/src\/(schema|server)\.ts$/.test(file))).toEqual([])
  expect(
    [...packages].filter((name) => name === 'bun:sqlite' || name.startsWith('drizzle-orm')),
  ).toEqual([])
})
