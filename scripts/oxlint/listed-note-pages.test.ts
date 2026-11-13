import { afterAll, expect, test } from 'bun:test'

import { cleanUpLintProbes, lintProbes } from './lint-probes'

afterAll(cleanUpLintProbes)

const pages = [
  'packages/note/src/ui/pages/essays/editor.tsx',
  'packages/note/src/ui/pages/essays/list.tsx',
  'packages/note/src/ui/pages/repos/editor.tsx',
]
const forbidden = [
  '@tanstack/react-query',
  '../../client.ts',
  '../../notes/open-note.ts',
  '../../notes/use-open-note.ts',
  '../../notes/removals.ts',
  '../../notes/star-toggle.ts',
]
const allowed = ['../../notes/use-listed-notes.ts', '../../notes/queries.ts']

function probe(specifiers: string[]): string {
  const imports = specifiers.map((specifier, i) => `import * as m${i} from '${specifier}'\n`)
  return `${imports.join('')}export const used = [${specifiers.map((_, i) => `m${i}`).join(', ')}]\n`
}

test('一覧を持つ画面は、Note の削除・作成・cache の書き換えを ListedNotes を通さずには import できない', async () => {
  const diagnostics = await lintProbes({
    ...Object.fromEntries(pages.map((path) => [path, probe([...forbidden, ...allowed])])),
    'packages/note/src/ui/pages/daily/index.tsx': probe(forbidden),
  })

  const refused = (path: string) =>
    new Set(
      diagnostics
        .filter((d) => d.filename === path && d.code === 'eslint(no-restricted-imports)')
        .map((d) => /^'(.+?)' import is restricted/.exec(d.message)?.[1]),
    )
  for (const path of pages) expect(refused(path)).toEqual(new Set(forbidden))
  expect(refused('packages/note/src/ui/pages/daily/index.tsx')).toEqual(new Set())
})
