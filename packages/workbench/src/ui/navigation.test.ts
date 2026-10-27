import { expect, test } from 'bun:test'

import type { Layout, RepoPlace } from '../contract.ts'
import {
  activeRunspaceOf,
  activeTabOf,
  type Entry,
  navigate,
  type Navigation,
  savedNavigation,
  selectedTileOf,
  type Step,
  type World,
} from './navigation.ts'
import { assignTiles, type BenchLabel, OUTSIDE, shownRunspaceIds } from './tile-assignment.ts'

type Runspace = Layout['runspaces'][number]

const APP = '/src/acme/app'
const LIB = '/src/acme/lib'
const DOC = '/src/acme/doc'
const HOME = '/home'

const places: Record<string, RepoPlace> = {
  [APP]: { repo: 'acme/app', path: 'app', branch: null },
  [LIB]: { repo: 'acme/lib', path: 'lib', branch: null },
  [DOC]: { repo: 'acme/doc', path: 'doc', branch: null },
}

function runspace(
  id: string,
  cwd: string,
  { tabs = 1, pinned = [] as number[], owned = false } = {},
): Runspace {
  return {
    id,
    cwd,
    sortOrder: 0,
    owned,
    tabs: Array.from({ length: tabs }, (_, i) => ({
      id: `${id}.${i}`,
      cwd,
      sortOrder: i,
      terminalSessionId: `ts-${id}.${i}`,
      pinned: pinned.includes(i),
    })),
  }
}

function worldOf(
  runspaces: Runspace[],
  {
    unread = [] as string[],
    collapsed = [] as string[],
    benches = {} as Record<string, BenchLabel>,
    unknown = [] as string[],
  } = {},
): World {
  const known = Object.fromEntries(Object.entries(places).filter(([cwd]) => !unknown.includes(cwd)))
  return {
    runspaces,
    tiles: assignTiles({ runspaces, places: known, benchLabelOf: (id) => benches[id] ?? null }),
    unreadOf: (terminalSessionId) => unread.includes(terminalSessionId),
    collapsed: new Set(collapsed),
  }
}

const fresh = savedNavigation({ activeRunspaceId: null, activeTabId: null, tile: null })

function run(world: World, entries: Entry[], from: Navigation = fresh): Step {
  return entries.reduce<Step>((step, entry) => navigate(step.state, entry, world), {
    state: from,
    focusTerminal: false,
  })
}

function onScreen(state: Navigation, world: World) {
  const active = activeRunspaceOf(state, world.runspaces)
  return {
    tile: selectedTileOf(state, world),
    runspace: active?.id,
    tab: active ? activeTabOf(state, active)?.id : undefined,
  }
}

const row = (runspaceId: string): Entry => ({ kind: 'row', runspaceId })
const tab = (tabId: string): Entry => ({ kind: 'tab', tabId })
const tile = (key: string): Entry => ({ kind: 'tile', key })
const notification = (terminalSessionId: string): Entry => ({
  kind: 'terminalSession',
  terminalSessionId,
})

function reload(state: Navigation, previous: World, world: World): Navigation {
  return navigate(state, { kind: 'layout', previous }, world).state
}

function withoutTabs(rows: Runspace[], tabIds: string[]): Runspace[] {
  return rows.map((r) => ({ ...r, tabs: r.tabs.filter((t) => !tabIds.includes(t.id)) }))
}

function shownIn(state: Navigation, world: World): string[] {
  return shownRunspaceIds(world.tiles, selectedTileOf(state, world), world.collapsed)
}

const down: Entry = { kind: 'cycleRunspace', direction: 'down' }
const up: Entry = { kind: 'cycleRunspace', direction: 'up' }
const left: Entry = { kind: 'cycleTab', direction: 'left' }
const right: Entry = { kind: 'cycleTab', direction: 'right' }

test.each([
  ['pressing a row', row('l'), true],
  ['pressing a Tab', tab('a.1'), true],
  ['pressing a Tile with a Runspace under it', tile('acme/lib'), true],
  ['pressing the Tile for outside the Repos with no Runspace under it', tile(OUTSIDE), false],
  ['clicking a notification', notification('ts-l.0'), true],
  ['clicking a notification of a Terminal Session no Tab shows', notification('ts-gone'), false],
  ['cycling Runspaces', down, false],
  ['cycling Tabs', right, false],
])("whether %s asks for the terminal's focus", (_, entry, focus) => {
  const world = worldOf([runspace('a', APP, { tabs: 2 }), runspace('l', LIB)])
  const shown = run(world, [row('a')]).state

  expect(run(world, [entry], shown).focusTerminal).toBe(focus)
})

test('pressing a row opens its leftmost unread Tab, or else the one last shown there', () => {
  const world = worldOf([runspace('a', APP, { tabs: 4 }), runspace('b', APP)], {
    unread: ['ts-a.3', 'ts-a.2'],
  })
  const shown = run(world, [row('a'), tab('a.1'), row('b')]).state

  const toUnread = run(world, [row('a')], shown)
  const toLastShown = run(worldOf(world.runspaces), [row('a')], shown)

  expect(onScreen(toUnread.state, world).tab).toBe('a.2')
  expect(onScreen(toLastShown.state, world).tab).toBe('a.1')
})

test("making a Pinned Runspace active leaves the Tile that was shown, and making another Runspace active brings up that Runspace's Tile", () => {
  const world = worldOf([
    runspace('a', APP),
    runspace('p', APP, { pinned: [0] }),
    runspace('l', LIB),
  ])
  const entries = [row('l'), row('p'), row('a')]
  const tiles = entries.map((_, i) =>
    selectedTileOf(run(world, entries.slice(0, i + 1)).state, world),
  )

  expect(tiles).toEqual(['acme/lib', 'acme/lib', 'acme/app'])
})

test('pressing a Tile brings up the Runspace last active under it with the Tab last shown there rather than an unread one, or else its first Runspace', () => {
  const runspaces = [runspace('a1', APP), runspace('a2', APP, { tabs: 2 }), runspace('l', LIB)]
  const shown = run(worldOf(runspaces), [row('a1'), row('a2'), tab('a2.1')]).state
  const world = worldOf(runspaces, { unread: ['ts-a2.0'] })

  const toLib = run(world, [tile('acme/lib')], shown).state
  const backToApp = run(world, [tile('acme/app')], toLib).state

  expect(onScreen(toLib, world)).toEqual({ tile: 'acme/lib', runspace: 'l', tab: 'l.0' })
  expect(onScreen(backToApp, world)).toEqual({ tile: 'acme/app', runspace: 'a2', tab: 'a2.1' })
})

test('pressing the Tile for outside the Repos with no Runspace under it brings up only that Tile, keeping the active Runspace', () => {
  const world = worldOf([runspace('a', APP)])

  const pressed = run(world, [row('a'), tile(OUTSIDE)]).state

  expect(onScreen(pressed, world)).toEqual({ tile: OUTSIDE, runspace: 'a', tab: 'a.0' })
})

test("while the Tile for outside the Repos is kept, pressing a Tab keeps it, and pressing a Tile brings back the active Runspace's Tile", () => {
  const world = worldOf([runspace('a', APP, { tabs: 2 }), runspace('l', LIB)])
  const kept = run(world, [row('a'), tile(OUTSIDE), tab('a.1')]).state

  const back = run(world, [tile('acme/app')], kept).state

  expect(onScreen(kept, world)).toEqual({ tile: OUTSIDE, runspace: 'a', tab: 'a.1' })
  expect(onScreen(back, world)).toEqual({ tile: 'acme/app', runspace: 'a', tab: 'a.1' })
})

test.each([
  ['another Runspace under another Tile is active', [row('l')]],
  ['the Tile for outside the Repos is kept', [row('a'), tile(OUTSIDE)]],
])(
  "a clicked notification brings up its Tab with that Tab's Runspace and Tile when %s",
  (_, before) => {
    const world = worldOf([runspace('a', APP, { tabs: 2 }), runspace('l', LIB)])

    const clicked = run(world, [...before, notification('ts-a.1')]).state

    expect(onScreen(clicked, world)).toEqual({ tile: 'acme/app', runspace: 'a', tab: 'a.1' })
  },
)

test('a clicked notification of a Tab in a Pinned Runspace leaves the Tile that was shown, even for an unpinned Tab of a Bench holding a pin', () => {
  const world = worldOf(
    [
      runspace('a', APP),
      runspace('l', LIB),
      runspace('p', LIB, { pinned: [0] }),
      runspace('b', APP, { tabs: 2, pinned: [0], owned: true }),
    ],
    { benches: { b: { repo: 'acme/app', number: 1, title: 'Ship it', setup: null } } },
  )
  const shown = run(world, [row('l')]).state

  const screens = ['ts-p.0', 'ts-b.1'].map((id) =>
    onScreen(run(world, [notification(id)], shown).state, world),
  )

  expect(screens).toEqual([
    { tile: 'acme/lib', runspace: 'p', tab: 'p.0' },
    { tile: 'acme/lib', runspace: 'b', tab: 'b.1' },
  ])
})

test('a clicked notification of a Terminal Session no Tab shows leaves the view as it is', () => {
  const world = worldOf([runspace('a', APP), runspace('l', LIB)])
  const shown = run(world, [row('l')]).state

  expect(run(world, [notification('ts-gone')], shown).state).toBe(shown)
})

test('cycling Runspaces goes through the Pinned rows and then the rows shown under the selected Tile, without going into another Repo', () => {
  const world = worldOf([
    runspace('a1', APP),
    runspace('p', APP, { pinned: [0] }),
    runspace('l', LIB),
    runspace('a2', APP),
  ])
  const entries = [row('a1'), down, down, down]

  const visited = entries
    .map((_, i) => run(world, entries.slice(0, i + 1)).state.activeRunspaceId)
    .slice(1)

  expect(visited).toEqual(['a2', 'p', 'a1'])
})

test('cycling Runspaces skips the rows of a collapsed section, and from an active row hidden there starts from the first row going down and from the last going up', () => {
  const world = worldOf(
    [runspace('b', APP, { owned: true }), runspace('a1', APP), runspace('a2', APP)],
    {
      benches: { b: { repo: 'acme/app', number: 1, title: 'Ship it', setup: null } },
      collapsed: ['acme/app:bench'],
    },
  )
  const hidden = run(world, [row('b')]).state

  const moved = [down, up].map((entry) => run(world, [entry], hidden).state.activeRunspaceId)

  expect(moved).toEqual(['a1', 'a2'])
})

test('cycling Tabs wraps around the Tabs of the active Runspace', () => {
  const world = worldOf([runspace('a', APP, { tabs: 3 })])
  const first = run(world, [row('a'), tab('a.0')]).state

  const toLast = run(world, [left], first).state
  const backToFirst = run(world, [right], toLast).state

  expect([onScreen(toLast, world).tab, onScreen(backToFirst, world).tab]).toEqual(['a.2', 'a.0'])
})

test.each([
  ['the active Tab moves to the Tab to its right', 'a.1', 'a.1', 'a.2'],
  ['the active Tab that was the last moves to the Tab to its left', 'a.2', 'a.2', 'a.1'],
  ['a Tab behind leaves the active Tab', 'a.0', 'a.2', 'a.0'],
])('a Tab gone from the layout however it was closed: %s', (_, active, closed, shown) => {
  const rows = [runspace('a', APP, { tabs: 3 })]
  const before = worldOf(rows)
  const after = worldOf(withoutTabs(rows, [closed]))
  const front = run(before, [row('a'), tab(active)]).state

  expect(onScreen(reload(front, before, after), after).tab).toBe(shown)
})

test('the Tab last shown in a Runspace not shown, once gone, gives way to the Tab next to it when that Runspace is opened', () => {
  const rows = [runspace('a', APP, { tabs: 3 }), runspace('l', LIB)]
  const before = worldOf(rows)
  const after = worldOf(withoutTabs(rows, ['a.1']))
  const away = run(before, [row('a'), tab('a.1'), row('l')]).state

  const opened = run(after, [row('a')], reload(away, before, after)).state

  expect(onScreen(opened, after)).toEqual({ tile: 'acme/app', runspace: 'a', tab: 'a.2' })
})

test.each([
  ['brings up the first Tab left after where they were', 'a.1', ['a.1', 'a.2'], 'a.3'],
  [
    'counts from where the active one was, even with a Tab before it gone',
    'a.1',
    ['a.0', 'a.1'],
    'a.2',
  ],
  ['brings up the last Tab left when none is left after them', 'a.2', ['a.2', 'a.3'], 'a.1'],
])('two Tabs gone in one reload %s', (_, active, gone, shown) => {
  const rows = [runspace('a', APP, { tabs: 4 })]
  const before = worldOf(rows)
  const after = worldOf(withoutTabs(rows, gone))
  const front = run(before, [row('a'), tab(active)]).state

  expect(onScreen(reload(front, before, after), after).tab).toBe(shown)
})

test('a Tab not in front moved into another Runspace leaves the view, and its Runspace brings up the Tab next to it', () => {
  const lib = runspace('l', LIB)
  const app = runspace('a', APP, { tabs: 3 })
  const before = worldOf([app, lib])
  const after = worldOf([
    ...withoutTabs([app], ['a.1']),
    { ...lib, tabs: [...lib.tabs, app.tabs[1]!] },
  ])
  const away = run(before, [row('a'), tab('a.1'), row('l')]).state

  const moved = reload(away, before, after)
  const opened = run(after, [row('a')], moved).state

  expect(onScreen(moved, after)).toEqual({ tile: 'acme/lib', runspace: 'l', tab: 'l.0' })
  expect(onScreen(opened, after).tab).toBe('a.2')
})

test('unpinning the Tab of the Pinned Runspace being shown brings up the Tile that Runspace goes back to, with its row shown there', () => {
  const before = worldOf([
    runspace('a', APP),
    runspace('l', LIB),
    runspace('p', LIB, { pinned: [0] }),
  ])
  const after = worldOf([runspace('a', APP), runspace('l', LIB), runspace('p', LIB)])
  const shown = run(before, [row('a'), row('p')]).state
  expect(selectedTileOf(shown, before)).toBe('acme/app')

  const unpinned = reload(shown, before, after)

  expect(onScreen(unpinned, after)).toEqual({ tile: 'acme/lib', runspace: 'p', tab: 'p.0' })
  expect(shownIn(unpinned, after)).toContain('p')
})

test('pinning the only Tab of the active Runspace leaves the Tile that was shown', () => {
  const before = worldOf([runspace('a', APP), runspace('l1', LIB), runspace('l2', LIB)])
  const after = worldOf([
    runspace('a', APP),
    runspace('l1', LIB, { pinned: [0] }),
    runspace('l2', LIB),
  ])
  const shown = run(before, [row('l1')]).state

  const pinned = reload(shown, before, after)

  expect(onScreen(pinned, after)).toEqual({ tile: 'acme/lib', runspace: 'l1', tab: 'l1.0' })
})

test('pinning a Tab with siblings follows it into its own Pinned Runspace and leaves the Tile that was shown', () => {
  const lib = runspace('l', LIB, { tabs: 2 })
  const before = worldOf([runspace('a', APP), lib])
  const split = { ...runspace('s', LIB), tabs: [{ ...lib.tabs[1]!, pinned: true }] }
  const after = worldOf([runspace('a', APP), { ...lib, tabs: [lib.tabs[0]!] }, split])
  const shown = run(before, [row('l'), tab('l.1')]).state

  const pinned = reload(shown, before, after)

  expect(onScreen(pinned, after)).toEqual({ tile: 'acme/lib', runspace: 's', tab: 'l.1' })
})

test('the front Tab moved into another Runspace takes the view and the Tile along, even when its own Runspace goes away', () => {
  const emptied = runspace('e', APP)
  const first = runspace('f', LIB)
  const before = worldOf([first, runspace('k', APP), emptied])
  const after = worldOf([{ ...first, tabs: [...first.tabs, ...emptied.tabs] }, runspace('k', APP)])
  const shown = run(before, [row('e'), tile(OUTSIDE)]).state

  const moved = reload(shown, before, after)

  expect(onScreen(moved, after)).toEqual({ tile: 'acme/lib', runspace: 'f', tab: 'e.0' })
})

test('closing the active Runspace in the middle of its Tile brings up the row just below it, with the Tab last shown there', () => {
  const rows = [runspace('a1', APP), runspace('a2', APP), runspace('a3', APP, { tabs: 2 })]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a2'))
  const shown = run(before, [row('a3'), tab('a3.1'), row('a2')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a3',
    tab: 'a3.1',
  })
})

test('closing the active Runspace at the bottom of its Tile brings up the row just above it, rather than a Runspace under another Tile active more recently', () => {
  const rows = [runspace('l', LIB), runspace('a1', APP), runspace('a2', APP)]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a2'))
  const shown = run(before, [row('a1'), row('l'), row('a2')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a1',
    tab: 'a1.0',
  })
})

test('closing the last row of the Bench section brings up the first row of the Runspaces section under the same Tile, even when that section is collapsed', () => {
  const benches = {
    b1: { repo: 'acme/app', number: 1, title: 'Ship it', setup: null },
    b2: { repo: 'acme/app', number: 2, title: 'Fix it', setup: null },
  }
  const rows = [
    runspace('b1', APP, { owned: true }),
    runspace('a1', APP),
    runspace('a2', APP),
    runspace('b2', APP, { owned: true }),
  ]
  const collapsed = ['acme/app:runspaces']
  const before = worldOf(rows, { benches, collapsed })
  const after = worldOf(
    rows.filter((r) => r.id !== 'b2'),
    { benches, collapsed },
  )
  const shown = run(before, [row('b2')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a1',
    tab: 'a1.0',
  })
})

test.each([
  [
    'the Tile just below it on the Rail',
    [runspace('a', APP), runspace('l1', LIB), runspace('l2', LIB)],
    ['l2', 'a'],
    { tile: 'acme/lib', runspace: 'l2', tab: 'l2.0' },
  ],
  [
    'the Tile just above it when below is only the Tile for outside the Repos with no Runspace under it',
    [runspace('a1', APP), runspace('a2', APP), runspace('l', LIB)],
    ['a2', 'l'],
    { tile: 'acme/app', runspace: 'a2', tab: 'a2.0' },
  ],
])(
  'closing the last Runspace under a Tile brings up %s, with the Runspace last active under that Tile',
  (_, rows, visited, shown) => {
    const closed = visited.at(-1)
    const before = worldOf(rows)
    const after = worldOf(rows.filter((r) => r.id !== closed))
    const opened = run(before, visited.map(row)).state

    expect(onScreen(reload(opened, before, after), after)).toEqual(shown)
  },
)

test.each([
  ['the first', 'a', 'acme/lib'],
  ['the middle', 'l', 'acme/doc'],
  ['the last', 'd', 'acme/lib'],
])(
  'closing the last Runspace under %s of three Repo Tiles brings up the Tile next to where it was on the Rail, looking below first',
  (_, closed, shown) => {
    const rows = [runspace('a', APP), runspace('l', LIB), runspace('d', DOC)]
    const before = worldOf(rows)
    const after = worldOf(rows.filter((r) => r.id !== closed))
    const opened = run(before, [row(closed)]).state

    expect(onScreen(reload(opened, before, after), after).tile).toBe(shown)
  },
)

test('closing the active Runspace while the Tile for outside the Repos is kept brings up the row next to it under its own Tile', () => {
  const rows = [runspace('l', LIB), runspace('a1', APP), runspace('a2', APP)]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a1'))
  const kept = run(before, [row('a1'), tile(OUTSIDE)]).state

  expect(onScreen(reload(kept, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a2',
    tab: 'a2.0',
  })
})

test('the first Runspace shown for a saved active Runspace no longer in the layout gives way to the first Runspace once it is closed', () => {
  const rows = [runspace('a1', APP), runspace('l', LIB), runspace('a2', APP)]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a1'))
  const restored = navigate(
    savedNavigation({ activeRunspaceId: 'gone', activeTabId: null, tile: null }),
    { kind: 'restore' },
    before,
  ).state

  expect(onScreen(reload(restored, before, after), after).runspace).toBe('l')
})

test('closing the active Pinned Runspace brings up the Runspace last active under the Tile that was shown', () => {
  const rows = [
    runspace('l', LIB),
    runspace('a1', APP),
    runspace('a2', APP),
    runspace('p', LIB, { pinned: [0] }),
  ]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'p'))
  const shown = run(before, [row('l'), row('a2'), row('p')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a2',
    tab: 'a2.0',
  })
})

test('a Runspace that is not active gone from the layout leaves the view as it is', () => {
  const rows = [runspace('a1', APP), runspace('a2', APP, { tabs: 2 }), runspace('l', LIB)]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a1'))
  const shown = run(before, [row('a2'), tab('a2.1')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: 'acme/app',
    runspace: 'a2',
    tab: 'a2.1',
  })
})

test('closing the active Runspace when only Pinned Runspaces are left gives way to the first Runspace', () => {
  const rows = [runspace('p', LIB, { pinned: [0] }), runspace('a', APP)]
  const before = worldOf(rows)
  const after = worldOf(rows.filter((r) => r.id !== 'a'))
  const shown = run(before, [row('a')]).state

  expect(onScreen(reload(shown, before, after), after)).toEqual({
    tile: OUTSIDE,
    runspace: 'p',
    tab: 'p.0',
  })
})

test('while the Tile for outside the Repos is kept, opening a Tab and a Runspace coming under that Tile keep it', () => {
  const w1 = worldOf([runspace('a', APP), runspace('l', LIB)])
  const w2 = worldOf([runspace('a', APP, { tabs: 2 }), runspace('l', LIB)])
  const w3 = worldOf([runspace('a', APP, { tabs: 2 }), runspace('l', LIB), runspace('h', HOME)])
  const kept = run(w1, [row('a'), tile(OUTSIDE)]).state

  const opened = run(w2, [tab('a.1')], reload(kept, w1, w2)).state
  const joined = reload(opened, w2, w3)

  expect(onScreen(opened, w2)).toEqual({ tile: OUTSIDE, runspace: 'a', tab: 'a.1' })
  expect(onScreen(joined, w3)).toEqual({ tile: OUTSIDE, runspace: 'a', tab: 'a.1' })
  expect(shownIn(joined, w3)).toEqual(['h'])
})

test.each([
  ['keeps the saved Tile when the restored active Runspace is Pinned', 'p', 'acme/lib', 'acme/lib'],
  ['keeps the saved Tile when it is the one for outside the Repos', 'a', OUTSIDE, OUTSIDE],
  ["otherwise brings up the restored active Runspace's Tile", 'a', 'acme/lib', 'acme/app'],
])('a restart %s', (_, activeRunspaceId, saved, shown) => {
  const world = worldOf([
    runspace('a', APP),
    runspace('l', LIB),
    runspace('p', LIB, { pinned: [0] }),
  ])
  const restored = savedNavigation({ activeRunspaceId, activeTabId: null, tile: saved })

  const { state } = navigate(restored, { kind: 'restore' }, world)

  expect(onScreen(state, world)).toMatchObject({ tile: shown, runspace: activeRunspaceId })
})

test('a saved Tile kept at a restart before its Repo is known comes up once it is', () => {
  const runspaces = [runspace('p', APP, { pinned: [0] }), runspace('a', APP), runspace('l', LIB)]
  const early = worldOf(runspaces, { unknown: [LIB] })
  const restored = savedNavigation({ activeRunspaceId: 'p', activeTabId: null, tile: 'acme/lib' })

  const { state } = navigate(restored, { kind: 'restore' }, early)

  expect(selectedTileOf(state, worldOf(runspaces))).toBe('acme/lib')
})

test('pressing a Tile after a restart brings back the Runspace active at the restart, even after visiting another Tile', () => {
  const world = worldOf([runspace('a1', APP), runspace('a2', APP), runspace('l', LIB)])
  const restored = navigate(
    savedNavigation({ activeRunspaceId: 'a2', activeTabId: null, tile: null }),
    { kind: 'restore' },
    world,
  ).state

  const visited = [tile('acme/lib'), tile('acme/app')].map(
    (_, i, entries) => run(world, entries.slice(0, i + 1), restored).state.activeRunspaceId,
  )

  expect(visited).toEqual(['l', 'a2'])
})

test('the selected Tile follows the active Runspace into its Repo once the Repo is known', () => {
  const runspaces = [runspace('a', APP), runspace('l', LIB)]
  const early = worldOf(runspaces, { unknown: [LIB] })
  const { state } = run(early, [row('l')])

  expect([selectedTileOf(state, early), selectedTileOf(state, worldOf(runspaces))]).toEqual([
    OUTSIDE,
    'acme/lib',
  ])
})
