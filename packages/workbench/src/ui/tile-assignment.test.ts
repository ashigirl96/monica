import { expect, test } from 'bun:test'

import { runspaceIn } from '../testing.ts'
import {
  assignTiles,
  type BenchLabel,
  OUTSIDE,
  type TileAssignment,
  tileKeyAt,
} from './tile-assignment.ts'

const APP = '/src/acme/app'
const LIB = '/src/acme/lib'
const OLD_APP = '/src/acme/old-app'
// repo の改名の前に作った worktree は、前の名前の checkout に登録されたまま残る。
const OLD_APP_WORKTREE = '/worktrees/acme/old-app/issue-2'
// 準備前の Bench は worktree がまだ無いので、Repo が引けない。
const UNPREPARED_WORKTREE = '/worktrees/acme/app/issue-3'
const HOME = '/Users/me'

const places = {
  [APP]: { repo: 'acme/app', path: 'app', branch: null },
  [LIB]: { repo: 'acme/lib', path: 'lib', branch: null },
  [OLD_APP]: { repo: 'acme/old-app', path: 'old-app', branch: null },
  [OLD_APP_WORKTREE]: { repo: 'acme/old-app', path: 'issue-2', branch: 'issue-2' },
}

function shownUnder(assignment: TileAssignment, key: string) {
  const tile = assignment.tiles.find((t) => t.key === key)
  return tile?.sections.map((s) => [s.kind, s.runspaceIds]) ?? []
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

test("a Runspace is listed under the Tile of its leftmost Tab's Repo, not under that of a Tab to its right", () => {
  const assignment = assignTiles({
    runspaces: [runspaceIn('rs', APP, { alsoIn: [LIB] })],
    places,
    benchLabelOf: () => null,
  })

  expect(assignment.tiles.map((tile) => tile.key)).toEqual(['acme/app', OUTSIDE])
  expect(shownUnder(assignment, 'acme/app')).toEqual([['runspaces', ['rs']]])
})

function appIssue(number: number): BenchLabel {
  return { repo: 'acme/app', number, title: `Issue ${number}`, setup: null }
}

test("a Bench is listed in the Bench section of its Task's Repo, whichever Repo its cwd is in, if any", () => {
  const labels: Record<string, BenchLabel> = {
    inPlace: appIssue(1),
    beforeRename: appIssue(2),
    unprepared: appIssue(3),
  }

  const assignment = assignTiles({
    runspaces: [
      runspaceIn('plain', APP),
      runspaceIn('elsewhere', OLD_APP),
      runspaceIn('inPlace', APP, { owned: true }),
      runspaceIn('beforeRename', OLD_APP_WORKTREE, { owned: true }),
      runspaceIn('unprepared', UNPREPARED_WORKTREE, { owned: true }),
    ],
    places,
    benchLabelOf: (id) => labels[id] ?? null,
  })

  expect(shownUnder(assignment, 'acme/app')).toEqual([
    ['bench', ['inPlace', 'beforeRename', 'unprepared']],
    ['runspaces', ['plain']],
  ])
  expect(shownUnder(assignment, 'acme/old-app')).toEqual([['runspaces', ['elsewhere']]])
})

test('Runspaces in no Repo are listed under the Tile at the bottom of the Rail, below the Tile of every Repo', () => {
  const assignment = assignTiles({
    runspaces: [
      runspaceIn('home', HOME),
      runspaceIn('inApp', APP),
      runspaceIn('downloads', `${HOME}/Downloads`),
    ],
    places,
    benchLabelOf: () => null,
  })

  expect(assignment.tiles.map((tile) => tile.key)).toEqual(['acme/app', OUTSIDE])
  expect(shownUnder(assignment, OUTSIDE)).toEqual([['runspaces', ['home', 'downloads']]])
})

test('Pinned Runspaces are listed apart from the Tiles, and under no Tile', () => {
  const assignment = assignTiles({
    runspaces: [
      runspaceIn('pinned', APP, { pinned: true }),
      runspaceIn('plain', APP),
      runspaceIn('home', HOME),
    ],
    places,
    benchLabelOf: () => null,
  })

  expect(assignment.pinned).toEqual(['pinned'])
  expect(
    assignment.tiles.map((tile) => [tile.key, tile.sections.flatMap((s) => s.runspaceIds)]),
  ).toEqual([
    ['acme/app', ['plain']],
    [OUTSIDE, ['home']],
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
