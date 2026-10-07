import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createStore, type Store } from 'jotai'

import { cleanUp, ghqCheckout, git, setup, until } from '../testing.ts'
import { jumpHintsActiveAtom, jumpHintTargetsAtom } from './jump-hints.ts'
import {
  type BenchLabel,
  OUTSIDE,
  type RunspaceRow,
  type Sidebar,
  rowMetaOf,
  type SidebarRow,
} from './sidebar-model.ts'
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  benchLabelOfAtom,
  cycleRunspaceAtom,
  moveActiveRunspaceAtom,
  reloadAgentSessionsAtom,
  reloadAtom,
  sidebarAtom,
  toggleSectionAtom,
  updateTabTitleAtom,
  workbenchClientAtom,
} from './store.ts'
import { railChoiceAtom } from './ui-state.ts'

const size = { rows: 24, cols: 80 }

afterEach(() => {
  cleanUp()
  setSystemTime()
})

function bench() {
  const backend = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => backend.client)
  // 通知を受けた Agent Session は、見たと記録されるまで未読のまま残る。
  const leaveUnread = async (terminalSessionId: string) => {
    await backend.client.agentSession.recordHook({
      terminalSessionId,
      payload: { session_id: `s-${terminalSessionId}`, cwd: '/work', hook_event_name: 'Stop' },
    })
    await store.set(reloadAgentSessionsAtom)
  }
  return { ...backend, store, leaveUnread }
}

function idsIn(sidebar: Sidebar, key: string): string[] {
  const rail = sidebar.rails.find((r) => r.key === key)
  return rail?.sections.flatMap((s) => s.rows.map((r) => r.id)) ?? []
}

// Repo は Backend への問い合わせを待って決まるので、札に行が出揃うまで待つ。
function untilListed(store: Store, key: string, ids: string[]): Promise<Sidebar> {
  return until(store, sidebarAtom, (sidebar) => {
    const listed = idsIn(sidebar, key)
    return ids.every((id) => listed.includes(id))
  })
}

function shown(sidebar: Sidebar) {
  return sidebar.selected.sections.map((s) => [s.kind, s.rows.map((r) => r.id)])
}

function rowOf(sidebar: Sidebar, runspaceId: string): RunspaceRow | undefined {
  const listed = sidebar.rails.flatMap((r) => r.sections.flatMap((s): SidebarRow[] => s.rows))
  return [...sidebar.pinned, ...listed]
    .filter((row): row is RunspaceRow => row.type === 'runspace')
    .find((row) => row.id === runspaceId)
}

test("a Runspace is listed under the rail of its leftmost Tab's Repo, and stays there whichever Tab is active", async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const { runspaceId } = await client.runspace.create({ cwd: app.checkout, ...size })
  const right = await client.tab.open({ runspaceId, cwd: lib.checkout, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [runspaceId])

  store.set(activateTerminalTabAtom, right.id)
  store.set(railChoiceAtom, 'acme/app')

  const sidebar = store.get(sidebarAtom)
  expect(sidebar.rails.map((r) => r.key)).toEqual(['acme/app', OUTSIDE])
  expect(shown(sidebar)).toEqual([['runspaces', [runspaceId]]])
})

test("a Bench is listed in the Bench section of its Task's Repo, whichever Repo its cwd is in, if any", async () => {
  const { db, workbenchLedger, client, store } = bench()
  const app = ghqCheckout('acme/app')
  // repo の改名の前に作った worktree は、前の名前の checkout に登録されたまま残る。
  const renamed = ghqCheckout('acme/old-app')
  const plain = await client.runspace.create({ cwd: app.checkout, ...size })
  const elsewhere = await client.runspace.create({ cwd: renamed.checkout, ...size })
  const benchIn = (cwd: string) =>
    db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd }))
  const inPlace = benchIn(app.checkout)
  const beforeRename = benchIn(renamed.worktree)
  const unprepared = benchIn(join(app.root, 'worktrees', 'acme', 'app', 'issue-3'))
  const labels: Record<string, BenchLabel> = {
    [inPlace]: { repo: 'acme/app', number: 1, title: 'Ship it', note: null },
    [beforeRename]: { repo: 'acme/app', number: 2, title: 'Fix it', note: null },
    [unprepared]: { repo: 'acme/app', number: 3, title: 'Try it', note: null },
  }
  store.set(benchLabelOfAtom, () => (runspaceId: string) => labels[runspaceId] ?? null)
  await store.set(reloadAtom)
  await untilListed(store, 'acme/old-app', [elsewhere.runspaceId])

  store.set(railChoiceAtom, 'acme/app')

  expect(shown(store.get(sidebarAtom))).toEqual([
    ['bench', [inPlace, beforeRename, unprepared]],
    ['runspaces', [plain.runspaceId]],
  ])
})

test('a Runspace of a worktree Tab taken out of a Bench is listed under the Repo of that worktree', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const { runspaceId } = await client.runspace.create({ cwd: app.worktree, ...size })
  await store.set(reloadAtom)

  const sidebar = await untilListed(store, 'acme/app', [runspaceId])

  expect(idsIn(sidebar, OUTSIDE)).toEqual([])
})

test('Runspaces in no Repo are listed under the rail at the bottom, below every Repo', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const home = await client.runspace.create({ cwd: app.root, ...size })
  const inApp = await client.runspace.create({ cwd: app.checkout, ...size })
  const downloads = await client.runspace.create({ cwd: app.elsewhere, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [inApp.runspaceId])

  store.set(railChoiceAtom, OUTSIDE)

  const sidebar = store.get(sidebarAtom)
  expect(sidebar.rails.map((r) => r.key)).toEqual(['acme/app', OUTSIDE])
  expect(shown(sidebar)).toEqual([['runspaces', [home.runspaceId, downloads.runspaceId]]])
})

test('a detached Terminal Session is listed in the Detached section of the Repo its Tab was last in', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const { runspaceId } = await client.runspace.create({ cwd: app.root, ...size })
  const closed = await client.tab.open({ runspaceId, ...size })
  await client.tab.setCwd({ id: closed.id, cwd: app.checkout })
  await client.tab.close({ id: closed.id })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [closed.terminalSessionId])

  store.set(railChoiceAtom, 'acme/app')

  expect(shown(store.get(sidebarAtom))).toEqual([['detached', [closed.terminalSessionId]]])
})

test('collapsing a section hides its rows and leaves their count and unread Tabs on its header, and expanding brings them back', async () => {
  const { client, store, leaveUnread } = bench()
  const app = ghqCheckout('acme/app')
  const a = await client.runspace.create({ cwd: app.checkout, ...size })
  const behind = await client.tab.open({ runspaceId: a.runspaceId, cwd: app.checkout, ...size })
  const b = await client.runspace.create({ cwd: app.checkout, ...size })
  const closed = await client.tab.open({ runspaceId: b.runspaceId, cwd: app.checkout, ...size })
  await client.tab.close({ id: closed.id })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [a.runspaceId, b.runspaceId, closed.terminalSessionId])
  await leaveUnread(behind.terminalSessionId)
  await leaveUnread(a.tab.terminalSessionId)
  store.set(railChoiceAtom, 'acme/app')

  store.set(toggleSectionAtom, 'acme/app:runspaces')

  expect(store.get(sidebarAtom).selected.sections).toMatchObject([
    { kind: 'runspaces', headed: true, collapsed: true, rows: [], rowCount: 2, unreadCount: 2 },
    { kind: 'detached', headed: true, collapsed: false, rowCount: 1, unreadCount: 0 },
  ])

  store.set(toggleSectionAtom, 'acme/app:runspaces')

  expect(shown(store.get(sidebarAtom))).toEqual([
    ['runspaces', [a.runspaceId, b.runspaceId]],
    ['detached', [closed.terminalSessionId]],
  ])
})

test('a Repo with one section has no header, and its rows stay shown even if that section was collapsed', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const { runspaceId } = await client.runspace.create({ cwd: app.checkout, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [runspaceId])
  store.set(railChoiceAtom, 'acme/app')

  store.set(toggleSectionAtom, 'acme/app:runspaces')

  expect(store.get(sidebarAtom).selected.sections).toMatchObject([
    { kind: 'runspaces', headed: false, collapsed: false, rows: [{ id: runspaceId }] },
  ])
})

test('a rail counts the unread Tabs of the rows it brings up, leaving out the Pinned rows', async () => {
  const { client, store, leaveUnread } = bench()
  const app = ghqCheckout('acme/app')
  const a = await client.runspace.create({ cwd: app.checkout, ...size })
  const second = await client.tab.open({ runspaceId: a.runspaceId, cwd: app.checkout, ...size })
  const pinned = await client.runspace.create({ cwd: app.checkout, ...size })
  await client.tab.pin({ id: pinned.tab.id })
  const closed = await client.tab.open({ runspaceId: a.runspaceId, cwd: app.checkout, ...size })
  await client.tab.close({ id: closed.id })
  const home = await client.runspace.create({ cwd: app.root, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [a.runspaceId, closed.terminalSessionId])

  for (const id of [a.tab, second, pinned.tab, closed]) await leaveUnread(id.terminalSessionId)

  expect(store.get(sidebarAtom).rails.map((r) => [r.key, r.unreadCount])).toEqual([
    ['acme/app', 3],
    [OUTSIDE, 0],
  ])
  expect(idsIn(store.get(sidebarAtom), OUTSIDE)).toEqual([home.runspaceId])
})

test('Pinned Runspaces are listed above whichever rail is selected, and under no rail', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const pinned = await client.runspace.create({ cwd: app.checkout, ...size })
  await client.tab.pin({ id: pinned.tab.id })
  const plain = await client.runspace.create({ cwd: app.checkout, ...size })
  await client.runspace.create({ cwd: app.root, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [plain.runspaceId])

  for (const key of ['acme/app', OUTSIDE]) {
    store.set(railChoiceAtom, key)
    const sidebar = store.get(sidebarAtom)
    expect(sidebar.pinned.map((r) => r.id)).toEqual([pinned.runspaceId])
    expect(idsIn(sidebar, key)).not.toContain(pinned.runspaceId)
  }
})

test("a Bench's row reads its Issue's title, then its terminal's title without Claude Code's spinner, and its number", async () => {
  const { db, workbenchLedger, client, store } = bench()
  const runspaceId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
  const tab = await client.tab.open({ runspaceId, ...size })
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', note: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === runspaceId ? label : null))
  await store.set(reloadAtom)

  await store.set(updateTabTitleAtom, tab.id, '✳ Fix the flaky test')

  expect(rowOf(store.get(sidebarAtom), runspaceId)).toMatchObject({
    title: 'Ship it',
    terminalTitle: 'Fix the flaky test',
    bench: { number: 12 },
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

  await store.set(updateTabTitleAtom, top.tab.id, '✻ Read the rail')
  await store.set(updateTabTitleAtom, deep.tab.id, '~/somewhere/packages/ui/src')

  const sidebar = store.get(sidebarAtom)
  expect(rowOf(sidebar, top.runspaceId)).toMatchObject({
    title: 'Read the rail',
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

test('the selected rail follows the active Runspace when keys cycle into another Repo, but picking a rail leaves the active Runspace alone', async () => {
  const { client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const inApp = await client.runspace.create({ cwd: app.checkout, ...size })
  const inLib = await client.runspace.create({ cwd: lib.checkout, ...size })
  await store.set(reloadAtom)
  await untilListed(store, 'acme/lib', [inLib.runspaceId])
  store.set(activateRunspaceAtom, inApp.runspaceId)
  store.set(railChoiceAtom, 'acme/app')

  store.set(cycleRunspaceAtom, 'down')

  expect(store.get(activeRunspaceAtom)?.id).toBe(inLib.runspaceId)
  expect(store.get(sidebarAtom).selected.key).toBe('acme/lib')

  store.set(railChoiceAtom, 'acme/app')

  expect(store.get(activeRunspaceAtom)?.id).toBe(inLib.runspaceId)
  expect(store.get(sidebarAtom).selected.key).toBe('acme/app')
})

test('moving a Runspace down past another of its Repo by key keeps the rails in their order', async () => {
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
  expect(sidebar.rails.map((r) => r.key)).toEqual(['acme/app', 'acme/lib', OUTSIDE])
  expect(idsIn(sidebar, 'acme/app')).toEqual([second.runspaceId, first.runspaceId])
})

test('jump hints number the Pinned rows and the rows shown under the selected rail, top down', async () => {
  const { db, workbenchLedger, client, store } = bench()
  const app = ghqCheckout('acme/app')
  const lib = ghqCheckout('acme/lib')
  const pinned = await client.runspace.create({ cwd: lib.checkout, ...size })
  await client.tab.pin({ id: pinned.tab.id })
  const listed = await client.runspace.create({ cwd: app.checkout, ...size })
  await client.runspace.create({ cwd: lib.checkout, ...size })
  const benchId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: app.checkout }))
  const label = { repo: 'acme/app', number: 1, title: 'Ship it', note: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === benchId ? label : null))
  await store.set(reloadAtom)
  await untilListed(store, 'acme/app', [listed.runspaceId])
  store.set(railChoiceAtom, 'acme/app')
  store.set(toggleSectionAtom, 'acme/app:bench')

  store.set(jumpHintsActiveAtom, true)

  expect(store.get(jumpHintTargetsAtom).byRunspaceId).toEqual({
    [pinned.runspaceId]: '1',
    [listed.runspaceId]: '2',
  })
})

const shell: RunspaceRow = {
  type: 'runspace',
  id: 'rs-1',
  isActive: false,
  unreadCount: 0,
  repo: 'acme/app',
  bench: null,
  title: 'Read the rail',
  titleIsPath: false,
  terminalTitle: 'Read the rail',
  path: 'packages/ui',
  branch: null,
}
const benchRow: RunspaceRow = {
  ...shell,
  bench: { repo: 'acme/app', number: 12, title: 'Ship it', note: null },
  title: 'Ship it',
}

test.each([
  ['a plain row in its Repo', shell, 'repo', null],
  [
    'a plain row in a linked worktree',
    { ...shell, branch: 'feature/rail' },
    'repo',
    { info: 'feature/rail', where: '' },
  ],
  ['a Bench', benchRow, 'repo', { info: 'Read the rail', where: '#12', chip: null }],
  [
    'a Bench being prepared',
    { ...benchRow, bench: { ...benchRow.bench!, note: { text: 'preparing', error: false } } },
    'repo',
    { note: { text: 'preparing', error: false }, where: '#12' },
  ],
  [
    'a row in no Repo',
    { ...shell, repo: null },
    'outside',
    { info: '', where: 'packages/ui', whereMono: true },
  ],
  [
    'a row in no Repo titled by its path',
    { ...shell, repo: null, titleIsPath: true },
    'outside',
    null,
  ],
  ['a Pinned row', shell, 'pinned', { chip: 'acme/app', where: 'app', whereMono: false }],
  [
    'a Pinned Bench',
    benchRow,
    'pinned',
    { info: 'Read the rail', chip: 'acme/app', where: 'app#12' },
  ],
] as const)('the second line of %s', (_, row, place, meta) => {
  if (meta === null) expect(rowMetaOf(row, place)).toBeNull()
  else expect(rowMetaOf(row, place)).toMatchObject(meta)
})
