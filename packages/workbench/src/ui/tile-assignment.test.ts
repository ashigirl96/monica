import { expect, test } from 'bun:test'

import { assignTiles, OUTSIDE, tileKeyAt } from './tile-assignment.ts'

const APP = '/src/acme/app'
const LIB = '/src/acme/lib'

const places = {
  [APP]: { repo: 'acme/app', path: 'app', branch: null },
  [LIB]: { repo: 'acme/lib', path: 'lib', branch: null },
}

function runspaceIn(id: string, cwd: string, { owned = false } = {}) {
  const tab = { id: `${id}.0`, cwd, sortOrder: 0, terminalSessionId: `ts-${id}`, pinned: false }
  return { id, cwd, sortOrder: 0, owned, tabs: [tab] }
}

test("a Bench and a checkout of the same Repo share a Tile whatever the case of the Repo's name", () => {
  const { tiles } = assignTiles({
    runspaces: [runspaceIn('plain', APP), runspaceIn('bench', APP, { owned: true })],
    places,
    // Task は GitHub の nameWithOwner で Repo を持つので、checkout の path と大小文字が違うことがある。
    benchLabelOf: (id) =>
      id === 'bench' ? { repo: 'Acme/App', number: 1, title: 'Ship it', setup: null } : null,
  })

  expect(tiles.map((tile) => [tile.key, tile.sections.flatMap((s) => s.runspaceIds)])).toEqual([
    ['acme/app', ['bench', 'plain']],
    [OUTSIDE, []],
  ])
})

test('a number picks the Tile of the Repo at that place from the top, 0 the Tile for outside the Repos, and a number with no Tile nothing', () => {
  const assignment = assignTiles({
    runspaces: [runspaceIn('a', APP), runspaceIn('l', LIB)],
    places,
    benchLabelOf: () => null,
  })

  expect([0, 1, 2, 3].map((n) => tileKeyAt(assignment, n))).toEqual([
    OUTSIDE,
    'acme/app',
    'acme/lib',
    undefined,
  ])
})
