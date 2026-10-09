import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createStore, type Store } from 'jotai'

import { cleanUp, ghqCheckout, git, onCleanup, runspaceIn, setup, until } from '../testing.ts'
import type { AgentDot } from './agent-dot.ts'
import { layoutAtom } from './backend-copy.ts'
import { jumpHintTargetsAtom, keymap } from './keys.ts'
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  pickTileByNumberAtom,
} from './navigation.ts'
import {
  buildSidebar,
  type RunspaceRow,
  rowMetaOf,
  type Sidebar,
  type SidebarInput,
} from './sidebar-model.ts'
import {
  appendRunspacesJoiningTile,
  moveActiveRunspaceAtom,
  reloadAgentSessionsAtom,
  reloadAtom,
  type Runspace,
  sidebarAtom,
  toggleSectionAtom,
  updateTabCwdAtom,
  updateTabTitleAtom,
  workbenchClientAtom,
} from './store.ts'
import {
  assignTiles,
  type BenchLabel,
  type BenchLabelOf,
  benchLabelOfAtom,
  OUTSIDE,
} from './tile-assignment.ts'

const size = { rows: 24, cols: 80 }

afterEach(() => {
  cleanUp()
  setSystemTime()
})

function bench() {
  const backend = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => backend.client)
  const record = async (terminalSessionId: string, hookEventName: string, fields: object = {}) => {
    await backend.client.agentSession.recordHook({
      terminalSessionId,
      payload: {
        session_id: `s-${terminalSessionId}`,
        cwd: '/work',
        hook_event_name: hookEventName,
        ...fields,
      },
    })
    await store.set(reloadAgentSessionsAtom)
  }
  return { ...backend, store, record }
}

function secondLineOf(sidebar: Sidebar, runspaceId: string) {
  const row = rowOf(sidebar, runspaceId)
  return row && rowMetaOf(row, 'repo')
}

function idsIn(sidebar: Sidebar, key: string): string[] {
  return (
    sidebar.tiles
      .find((tile) => tile.key === key)
      ?.sections.flatMap((s) => s.rows.map((r) => r.id)) ?? []
  )
}

// Repo は Backend への問い合わせを待って決まるので、Tile に行が出揃うまで待つ。
function untilListed(store: Store, key: string, ids: string[]): Promise<Sidebar> {
  return until(store, sidebarAtom, (sidebar) => {
    const listed = idsIn(sidebar, key)
    return ids.every((id) => listed.includes(id))
  })
}

function sectionsOf(sidebar: Sidebar, key: string) {
  return sidebar.tiles.find((tile) => tile.key === key)?.sections ?? []
}

function shownUnder(sidebar: Sidebar, key: string) {
  return sectionsOf(sidebar, key).map((s) => [s.kind, s.rows.map((r) => r.id)])
}

function listedRows(sidebar: Sidebar): RunspaceRow[] {
  return sidebar.tiles.flatMap((tile) => tile.sections.flatMap((s) => s.rows))
}

function rowOf(sidebar: Sidebar, runspaceId: string): RunspaceRow | undefined {
  return [...sidebar.pinned, ...listedRows(sidebar)].find((row) => row.id === runspaceId)
}

const APP = '/src/acme/app'
const WORKTREE = '/worktrees/acme/app/issue-1'
const places = {
  [APP]: { repo: 'acme/app', path: 'app', branch: null },
  [WORKTREE]: { repo: 'acme/app', path: 'issue-1', branch: 'issue-1' },
}

function sidebarOf(
  runspaces: Runspace[],
  {
    benchLabelOf = () => null,
    unreadOf = () => false,
    agentDotOf = () => null,
    collapsed = new Set(),
  }: Partial<Pick<SidebarInput, 'unreadOf' | 'agentDotOf' | 'collapsed'>> & {
    benchLabelOf?: BenchLabelOf
  } = {},
): Sidebar {
  return buildSidebar({
    runspaces,
    assignment: assignTiles({ runspaces, places, benchLabelOf }),
    selectedTile: 'acme/app',
    activeRunspaceId: null,
    activeTabOf: (runspace) => runspace.tabs[0] ?? null,
    titles: {},
    places,
    unreadOf,
    agentDotOf,
    collapsed,
  })
}

test('collapsing a section hides its rows and leaves their count and unread Tabs on its header, and expanding brings them back', () => {
  const runspaces = [
    runspaceIn('shipIt', WORKTREE, { owned: true }),
    runspaceIn('a', APP, { alsoIn: [APP] }),
    runspaceIn('b', APP),
  ]
  const label: BenchLabel = { repo: 'acme/app', number: 1, title: 'Ship it', setup: null }
  const benchLabelOf = (id: string) => (id === 'shipIt' ? label : null)
  const unread = new Set(['ts-a.0', 'ts-a.1'])
  const unreadOf = (id: string) => unread.has(id)

  const folded = sidebarOf(runspaces, {
    benchLabelOf,
    unreadOf,
    collapsed: new Set(['acme/app:runspaces']),
  })
  const unfolded = sidebarOf(runspaces, { benchLabelOf, unreadOf })

  expect(sectionsOf(folded, 'acme/app')).toMatchObject([
    { kind: 'bench', headed: true, collapsed: false, rowCount: 1, unreadCount: 0 },
    { kind: 'runspaces', headed: true, collapsed: true, rows: [], rowCount: 2, unreadCount: 2 },
  ])
  expect(shownUnder(unfolded, 'acme/app')).toEqual([
    ['bench', ['shipIt']],
    ['runspaces', ['a', 'b']],
  ])
})

test('a Repo with one section has no header, and its rows stay shown even if that section was collapsed', () => {
  const sidebar = sidebarOf([runspaceIn('rs', APP)], {
    collapsed: new Set(['acme/app:runspaces']),
  })

  expect(sectionsOf(sidebar, 'acme/app')).toMatchObject([
    { kind: 'runspaces', headed: false, collapsed: false, rows: [{ id: 'rs' }] },
  ])
})

test('a Tile counts the unread Tabs of the rows it brings up, leaving out the Pinned rows', () => {
  const runspaces = [
    runspaceIn('a', APP, { alsoIn: [APP] }),
    runspaceIn('pinned', APP, { pinned: true }),
    runspaceIn('b', APP),
    runspaceIn('home', '/Users/me'),
  ]
  const unread = new Set(['ts-a.0', 'ts-a.1', 'ts-pinned.0', 'ts-b.0'])

  const sidebar = sidebarOf(runspaces, { unreadOf: (id) => unread.has(id) })

  expect(sidebar.tiles.map((tile) => [tile.key, tile.unreadCount])).toEqual([
    ['acme/app', 3],
    [OUTSIDE, 0],
  ])
  expect(idsIn(sidebar, OUTSIDE)).toEqual(['home'])
})

test("a plain Runspace's second line starts with how many of its Tabs show each color of dot", () => {
  const dots: Record<string, AgentDot> = {
    'ts-rs.0': 'running',
    'ts-rs.1': 'running',
    'ts-rs.2': 'question',
  }
  const runspace = runspaceIn('rs', WORKTREE, { alsoIn: [WORKTREE, WORKTREE, WORKTREE] })

  const sidebar = sidebarOf([runspace], { agentDotOf: (id) => dots[id] ?? null })

  expect(secondLineOf(sidebar, 'rs')).toMatchObject({
    tallies: [
      { kind: 'running', count: 2 },
      { kind: 'questionOrPermission', count: 1 },
    ],
    info: 'issue-1',
  })
})

test('a Runspace of a worktree Tab taken out of a Bench is listed under the Repo of that worktree', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const { runspaceId } = await client.runspace.create({ cwd: app.worktree, ...size })
  await store.set(reloadAtom)

  const sidebar = await untilListed(store, 'acme/app', [runspaceId])

  expect(idsIn(sidebar, OUTSIDE)).toEqual([])
})

test("a Bench's row reads its Issue's title, then its terminal's title with Claude Code's spinner as it is, and its number", async () => {
  const { db, workbenchLedger, client, store } = bench()
  const runspaceId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
  const tab = await client.tab.open({ runspaceId, ...size })
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', setup: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === runspaceId ? label : null))
  await store.set(reloadAtom)

  await store.set(updateTabTitleAtom, tab.id, '✳ Fix the flaky test')

  expect(rowOf(store.get(sidebarAtom), runspaceId)).toMatchObject({
    title: 'Ship it',
    terminalTitle: '✳ Fix the flaky test',
    bench: { number: 12 },
  })
})

test("a Bench's second line shows the dot and the terminal's title of the Tab whose claude most needs a hand, the leftmost among equals", async () => {
  const { db, workbenchLedger, client, store, record } = bench()
  const runspaceId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
  const front = await client.tab.open({ runspaceId, ...size })
  const behind = await client.tab.open({ runspaceId, ...size })
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', setup: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === runspaceId ? label : null))
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, runspaceId)
  store.set(activateTerminalTabAtom, front.id)
  await store.set(updateTabTitleAtom, front.id, '✳ Fix the flaky test')
  await store.set(updateTabTitleAtom, behind.id, '✻ Read the tile')
  await record(front.terminalSessionId, 'UserPromptSubmit')
  await record(behind.terminalSessionId, 'UserPromptSubmit')

  await record(behind.terminalSessionId, 'PermissionRequest', { tool_name: 'Bash' })
  const asking = secondLineOf(store.get(sidebarAtom), runspaceId)
  await record(behind.terminalSessionId, 'PostToolUse', { tool_name: 'Bash' })

  expect(asking).toMatchObject({
    tallies: [],
    dot: 'permission',
    info: '✻ Read the tile',
    where: '#12',
  })
  expect(secondLineOf(store.get(sidebarAtom), runspaceId)).toMatchObject({
    dot: 'running',
    info: '✳ Fix the flaky test',
  })
})

// 未観測は Backend の起こし直しでしか作れないので、順位は sidebar の入力に dot を直に渡して確かめる。
function benchRowWith(dots: (AgentDot | null)[], activeIndex = 0): RunspaceRow | undefined {
  const tabs = dots.map((_, i) => ({
    id: `tab-${i}`,
    cwd: '/work',
    sortOrder: i,
    terminalSessionId: `ts-${i}`,
    pinned: false,
  }))
  const runspaces = [{ id: 'rs-bench', cwd: '/work', sortOrder: 0, owned: true, tabs }]
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', setup: null }
  const sidebar = buildSidebar({
    runspaces,
    assignment: assignTiles({ runspaces, places: {}, benchLabelOf: () => label }),
    selectedTile: 'acme/app',
    activeRunspaceId: 'rs-bench',
    activeTabOf: () => tabs[activeIndex] ?? null,
    titles: Object.fromEntries(tabs.map((t, i) => [t.id, `claude ${i}`])),
    places: {},
    unreadOf: () => false,
    agentDotOf: (id) => dots[tabs.findIndex((t) => t.terminalSessionId === id)] ?? null,
    collapsed: new Set(),
  })
  return rowOf(sidebar, 'rs-bench')
}

test.each([
  ['question', 'error'],
  ['permission', 'error'],
  ['error', 'running'],
  ['running', 'idle'],
  ['idle', 'unobserved'],
] as const)(
  "a Bench's second line follows a Tab showing %s over one showing %s, on either side",
  (over, under) => {
    const rows = [benchRowWith([under, over]), benchRowWith([over, under])]

    expect(rows.map((row) => [row?.agentDot, row?.terminalTitle])).toEqual([
      [over, 'claude 1'],
      [over, 'claude 0'],
    ])
  },
)

test("a Bench's second line follows the leftmost of Tabs whose claudes need a hand alike, even while another is active", () => {
  const row = benchRowWith(['permission', 'question'], 1)

  expect([row?.agentDot, row?.terminalTitle]).toEqual(['permission', 'claude 0'])
})

test("a Bench with no claude shows no dot and takes its terminal's title from the active Tab", () => {
  const row = benchRowWith([null, null], 1)

  expect([row?.agentDot, row?.terminalTitle]).toEqual([null, 'claude 1'])
})

test('a Bench being prepared, with no Tab yet, has only the setup and its number on its second line', async () => {
  const { db, workbenchLedger, store } = bench()
  const runspaceId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
  const preparing = { text: 'preparing', error: false }
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', setup: preparing }
  store.set(benchLabelOfAtom, () => (id: string) => (id === runspaceId ? label : null))
  await store.set(reloadAtom)

  expect(secondLineOf(store.get(sidebarAtom), runspaceId)).toEqual({
    setup: preparing,
    tallies: [],
    dot: null,
    info: '',
    infoMono: false,
    chip: null,
    where: '#12',
    whereMono: true,
  })
})

test("a plain Runspace's row reads its terminal's title, or where the shell is inside the Repo while the title is a path", async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const deepDir = join(app.checkout, 'packages', 'ui', 'src')
  mkdirSync(deepDir, { recursive: true })
  const top = await client.runspace.create({ cwd: app.checkout, ...size })
  const deep = await client.runspace.create({ cwd: deepDir, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [top.runspaceId, deep.runspaceId])

  await store.set(updateTabTitleAtom, top.tab.id, '✻ Read the tile')
  await store.set(updateTabTitleAtom, deep.tab.id, '~/somewhere/packages/ui/src')

  const sidebar = store.get(sidebarAtom)
  expect(rowOf(sidebar, top.runspaceId)).toMatchObject({
    title: '✻ Read the tile',
    titleIsPath: false,
  })
  expect(rowOf(sidebar, deep.runspaceId)).toMatchObject({
    title: 'packages/ui/src',
    titleIsPath: true,
  })
})

test("a plain Runspace's row carries the branch only while its active Tab is in a linked worktree", async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const inWorktree = await client.runspace.create({ cwd: app.worktree, ...size })
  const inCheckout = await client.runspace.create({ cwd: app.checkout, ...size })
  await store.set(reloadAtom)

  const sidebar = await untilListed(store, 'acme/app', [
    inWorktree.runspaceId,
    inCheckout.runspaceId,
  ])

  expect(rowOf(sidebar, inWorktree.runspaceId)?.branch).toBe('issue-1')
  expect(rowOf(sidebar, inCheckout.runspaceId)?.branch).toBeNull()
})

test('a plain Runspace with no branch has a second line from when its claude starts until it ends, even while the claude waits for the next prompt', async () => {
  const { home, client, store, record } = bench()
  const { runspaceId, tab } = await client.runspace.create({ cwd: home, ...size })
  await client.tab.open({ runspaceId, cwd: home, ...size })
  await store.set(reloadAtom)
  const lines = [secondLineOf(store.get(sidebarAtom), runspaceId)]

  await record(tab.terminalSessionId, 'UserPromptSubmit')
  await record(tab.terminalSessionId, 'Stop')
  lines.push(secondLineOf(store.get(sidebarAtom), runspaceId))
  await record(tab.terminalSessionId, 'SessionEnd', { reason: 'prompt_input_exit' })
  lines.push(secondLineOf(store.get(sidebarAtom), runspaceId))

  expect(lines).toMatchObject([null, { tallies: [{ kind: 'idle', count: 1 }], info: '' }, null])
})

test('a branch switched in a terminal that reports nothing reaches the row on a layout reload 5 seconds later', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const { runspaceId } = await client.runspace.create({ cwd: app.worktree, ...size })
  await store.set(reloadAtom)
  await until(store, sidebarAtom, (s) => rowOf(s, runspaceId)?.branch === 'issue-1')

  git(app.worktree, 'switch', '--quiet', '-c', 'feature/renamed')
  setSystemTime(new Date(Date.now() + 5000))
  await store.set(reloadAtom)

  const sidebar = await until(store, sidebarAtom, (s) => rowOf(s, runspaceId)?.branch !== 'issue-1')
  expect(rowOf(sidebar, runspaceId)?.branch).toBe('feature/renamed')
})

test('a Runspace brought up by a number takes the selected Tile along when its shell moves into another Repo', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const inApp = await client.runspace.create({ cwd: app.checkout, ...size })
  // Tile に行が残らないと Tile ごと消えて、選んだ Tile に関わらず active な Runspace の Tile が出る。
  await client.runspace.create({ cwd: app.checkout, ...size })
  const inLib = await client.runspace.create({ cwd: lib.checkout, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/lib', [inLib.runspaceId])
  store.set(pickTileByNumberAtom, 1)

  await store.set(updateTabCwdAtom, inApp.tab.id, lib.checkout)
  await store.set(reloadAtom)

  const sidebar = await untilListed(store, 'acme/lib', [inApp.runspaceId])
  expect(sidebar.selected.key).toBe('acme/lib')
})

test('moving a Runspace down past another of its Repo by key keeps the Tiles in their order', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const first = await client.runspace.create({ cwd: app.checkout, ...size })
  const inLib = await client.runspace.create({ cwd: lib.checkout, ...size })
  const second = await client.runspace.create({ cwd: app.checkout, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/lib', [inLib.runspaceId])
  store.set(activateRunspaceAtom, first.runspaceId)

  await store.set(moveActiveRunspaceAtom, 'down')

  const sidebar = store.get(sidebarAtom)
  expect(sidebar.tiles.map((tile) => tile.key)).toEqual(['acme/app', 'acme/lib', OUTSIDE])
  expect(idsIn(sidebar, 'acme/app')).toEqual([second.runspaceId, first.runspaceId])
})

test("a Runspace whose shell moves into another Repo goes to the bottom of the rows under that Repo's Tile, one that steps out of the Repos and back stays put, and a Repo new to the Rail gets a Tile below the others", async () => {
  const { db, workbenchLedger, client, store } = bench()
  onCleanup(appendRunspacesJoiningTile(store))
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const zed = ghqCheckout('acme/zed')
  const toLib = await client.runspace.create({ cwd: app.root, ...size })
  const toZed = await client.runspace.create({ cwd: app.root, ...size })
  const inApp = await client.runspace.create({ cwd: app.checkout, ...size })
  const inLib = await client.runspace.create({ cwd: lib.checkout, ...size })
  // Bench は動かないので、Repo が初めて引けたときに動かすと、Bench が前へ出て Tile の順が変わる。
  const shipIt = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: lib.worktree }))
  const label: BenchLabel = { repo: 'acme/lib', number: 1, title: 'Ship it', setup: null }
  store.set(benchLabelOfAtom, () => (runspaceId: string) => (runspaceId === shipIt ? label : null))
  await store.set(reloadAtom)
  await untilListed(store, 'acme/lib', [inLib.runspaceId])
  // 末尾への移動は Repo が引けた後に Backend を往復するので、並びが落ち着くまで待つ。
  const untilLast = (runspaceId: string) =>
    until(store, layoutAtom, (layout) => layout?.runspaces.at(-1)?.id === runspaceId)

  await store.set(updateTabCwdAtom, toLib.tab.id, lib.checkout)
  await store.set(reloadAtom)
  await untilLast(toLib.runspaceId)
  const joinedLib = await untilListed(store, 'acme/lib', [toLib.runspaceId])
  for (const cwd of [app.root, lib.checkout]) {
    await store.set(updateTabCwdAtom, inLib.tab.id, cwd)
    await store.set(reloadAtom)
  }
  // 移動は送った順に Backend が書くので、後の移動が済めば前の移動も済んでいる。
  await store.set(updateTabCwdAtom, toZed.tab.id, zed.checkout)
  await store.set(reloadAtom)
  await untilLast(toZed.runspaceId)
  const joinedZed = await untilListed(store, 'acme/zed', [toZed.runspaceId])
  await store.set(updateTabCwdAtom, inLib.tab.id, app.checkout)
  await store.set(reloadAtom)
  await untilLast(inLib.runspaceId)
  const joinedApp = await untilListed(store, 'acme/app', [inLib.runspaceId])

  expect(idsIn(joinedLib, 'acme/lib')).toEqual([shipIt, inLib.runspaceId, toLib.runspaceId])
  expect(joinedLib.tiles.map((tile) => tile.key)).toEqual(['acme/app', 'acme/lib', OUTSIDE])
  expect(idsIn(joinedZed, 'acme/lib')).toEqual([shipIt, inLib.runspaceId, toLib.runspaceId])
  expect(joinedZed.tiles.map((tile) => tile.key)).toEqual([
    'acme/app',
    'acme/lib',
    'acme/zed',
    OUTSIDE,
  ])
  expect(idsIn(joinedApp, 'acme/app')).toEqual([inApp.runspaceId, inLib.runspaceId])
})

test('jump hints number the Pinned rows and the rows shown under the selected Tile, top down', async () => {
  const { db, workbenchLedger, client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const pinned = await client.runspace.create({ cwd: lib.checkout, ...size })
  await client.tab.pin({ id: pinned.tab.id })
  const listed = await client.runspace.create({ cwd: app.checkout, ...size })
  await client.runspace.create({ cwd: lib.checkout, ...size })
  const benchId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: app.checkout }))
  const label = { repo: 'acme/app', number: 1, title: 'Ship it', setup: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === benchId ? label : null))
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [listed.runspaceId])
  store.set(activateRunspaceAtom, listed.runspaceId)
  store.set(toggleSectionAtom, 'acme/app:bench')

  const ctrlT = { key: 't', code: 'KeyT', meta: false, ctrl: true, alt: false, shift: false }
  keymap.press(store, { ...ctrlT, repeat: false, editable: false })

  expect(store.get(jumpHintTargetsAtom).byRunspaceId).toEqual({
    [pinned.runspaceId]: '1',
    [listed.runspaceId]: '2',
  })
})

const shell: RunspaceRow = {
  id: 'rs-1',
  isActive: false,
  unreadCount: 0,
  agentTallies: [],
  agentDot: null,
  repo: 'acme/app',
  bench: null,
  title: 'Read the tile',
  titleIsPath: false,
  terminalTitle: 'Read the tile',
  path: 'packages/ui',
  branch: null,
}
const withClaudes: RunspaceRow = {
  ...shell,
  agentTallies: [
    { kind: 'running', count: 2 },
    { kind: 'questionOrPermission', count: 1 },
  ],
}
const benchRow: RunspaceRow = {
  ...shell,
  agentDot: 'question',
  bench: { repo: 'acme/app', number: 12, title: 'Ship it', setup: null },
  title: 'Ship it',
}

test.each([
  ['a plain row in its Repo', shell, 'repo', null],
  [
    'a plain row in a linked worktree',
    { ...withClaudes, branch: 'feature/tile' },
    'repo',
    { tallies: withClaudes.agentTallies, dot: null, info: 'feature/tile', where: '' },
  ],
  [
    'a Bench',
    benchRow,
    'repo',
    { tallies: [], dot: 'question', info: 'Read the tile', where: '#12', chip: null },
  ],
  [
    'a Bench being prepared',
    { ...benchRow, bench: { ...benchRow.bench!, setup: { text: 'preparing', error: false } } },
    'repo',
    { setup: { text: 'preparing', error: false }, where: '#12' },
  ],
  [
    'a row in no Repo',
    { ...withClaudes, repo: null },
    'outside',
    { tallies: withClaudes.agentTallies, info: '', where: 'packages/ui', whereMono: true },
  ],
  [
    'a row in no Repo titled by its path',
    { ...shell, repo: null, titleIsPath: true },
    'outside',
    null,
  ],
  [
    'a Pinned row',
    withClaudes,
    'pinned',
    {
      tallies: withClaudes.agentTallies,
      dot: null,
      chip: 'acme/app',
      where: 'app',
      whereMono: false,
    },
  ],
  [
    'a Pinned Bench',
    benchRow,
    'pinned',
    { tallies: [], dot: 'question', info: 'Read the tile', chip: 'acme/app', where: 'app#12' },
  ],
] as const)('the second line of %s', (_, row, place, meta) => {
  if (meta === null) expect(rowMetaOf(row, place)).toBeNull()
  else expect(rowMetaOf(row, place)).toMatchObject(meta)
})
