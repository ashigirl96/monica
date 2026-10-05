import { afterEach, expect, mock, setSystemTime, test } from 'bun:test'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { Atom, Store } from 'jotai'

// Shell の command は Tauri の外では呼べないので、呼ばれた command だけを記録する。
const shellCalls: { command: string; args: Record<string, unknown> }[] = []
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string, args: Record<string, unknown>) => {
    shellCalls.push({ command, args })
  },
}))

// toast は画面の外にあるので、出した文言だけを記録する。
const toasts: string[] = []
const ui = await import('@tania/ui')
await mock.module('@tania/ui', () => ({
  ...ui,
  pushErrorToast: (message: string) => {
    toasts.push(message)
  },
}))

const { createStore } = await import('jotai')
const { cleanUp, git, linkedWorktree, setup } = await import('../testing.ts')
const {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  closeTerminalTabAtom,
  createRunspaceAtom,
  createTerminalTabAtom,
  cycleRunspaceAtom,
  deadTabsAtom,
  terminateTerminalSessionAtom,
  moveActiveRunspaceAtom,
  moveTabToRunspaceAtom,
  reattachTerminalSessionAtom,
  reloadAtom,
  reorderRunspacesAtom,
  reorderTabsAtom,
  runspaceSummariesAtom,
  startNewShellForTabAtom,
  tabExitedAtom,
  terminateTabTerminalSessionAtom,
  toggleTabPinAtom,
  updateTabCwdAtom,
  updateTabTitleAtom,
  workbenchClientAtom,
} = await import('./store.ts')
const { detachedTerminalSessionsAtom, terminalSessionStatusAtom } =
  await import('./terminal-sessions.ts')
const { getTabConnection, openTabConnection } = await import('./terminal-connections.ts')

const size = { rows: 24, cols: 80 }

afterEach(() => {
  cleanUp()
  shellCalls.length = 0
  toasts.length = 0
  setSystemTime()
})

function bench() {
  const backend = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => backend.client)
  return { ...backend, store }
}

function until<T>(store: Store, atom: Atom<T>, done: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const check = () => {
      const value = store.get(atom)
      if (!done(value)) return
      unsubscribe()
      resolve(value)
    }
    const unsubscribe = store.sub(atom, check)
    check()
  })
}

test('an empty layout gets one Runspace, even when two reloads race', async () => {
  const { client, store } = bench()

  await Promise.all([store.set(reloadAtom), store.set(reloadAtom)])

  expect((await client.layout.get()).runspaces).toHaveLength(1)
})

test("a new Runspace goes right after the active one, in its active Tab's cwd, and becomes active", async () => {
  const { client, store } = bench()
  const a = await client.runspace.create({ cwd: '/a', ...size })
  const b = await client.runspace.create({ cwd: '/b', ...size })
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, a.runspaceId)

  await store.set(createRunspaceAtom)

  const { runspaces } = await client.layout.get()
  expect(runspaces.map((r) => r.id)).toEqual([a.runspaceId, expect.any(String), b.runspaceId])
  expect(runspaces[1]?.cwd).toBe('/a')
  expect(store.get(activeRunspaceAtom)?.id).toBe(runspaces[1]!.id)
})

test('a new Tab goes right after the active one, in its cwd, and becomes active', async () => {
  const { client, store } = bench()
  const { runspaceId, tab: first } = await client.runspace.create({ cwd: '/a', ...size })
  const last = await client.tab.open({ runspaceId, cwd: '/b', ...size })
  await store.set(reloadAtom)

  await store.set(createTerminalTabAtom)

  const tabs = (await client.layout.get()).runspaces[0]!.tabs
  expect(tabs.map((t) => t.id)).toEqual([first.id, expect.any(String), last.id])
  expect(tabs[1]?.cwd).toBe('/a')
  expect(store.get(activeTerminalTabAtom)?.id).toBe(tabs[1]!.id)
})

test('closing the active Tab leaves its Terminal Session detached and activates the Tab that took its place', async () => {
  const { client, store } = bench()
  const { runspaceId, tab: a } = await client.runspace.create(size)
  const b = await client.tab.open({ runspaceId, ...size })
  const c = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, b.id)

  await store.set(closeTerminalTabAtom)

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id, c.id])
  expect(store.get(activeTerminalTabAtom)?.id).toBe(c.id)
  expect(await client.terminalSession.list()).toContainEqual(
    expect.objectContaining({ id: b.terminalSessionId, status: 'running', tabId: null }),
  )
  expect(shellCalls).toContainEqual({
    command: 'terminal_detach',
    args: { sessionId: b.terminalSessionId },
  })
})

test('closing the last Tab of the last Runspace leaves a fresh Runspace', async () => {
  const { client, store } = bench()
  await store.set(reloadAtom)
  const before = (await client.layout.get()).runspaces[0]!

  await store.set(closeTerminalTabAtom)

  const { runspaces } = await client.layout.get()
  expect(runspaces.map((r) => r.id)).toEqual([expect.not.stringMatching(before.id)])
  expect(store.get(activeRunspaceAtom)?.id).toBe(runspaces[0]!.id)
})

test("dragging a Runspace onto another puts it in that one's place", async () => {
  const { client, store } = bench()
  const [a, b, c] = [
    await client.runspace.create(size),
    await client.runspace.create(size),
    await client.runspace.create(size),
  ].map((r) => r.runspaceId)
  await store.set(reloadAtom)
  const order = async () => (await client.layout.get()).runspaces.map((r) => r.id)

  await store.set(reorderRunspacesAtom, a!, c!)
  expect(await order()).toEqual([b, c, a])

  await store.set(reorderRunspacesAtom, a!, b!)
  expect(await order()).toEqual([a, b, c])
})

test("dragging a Tab onto another in the header puts it in that one's place", async () => {
  const { client, store } = bench()
  const { runspaceId, tab: a } = await client.runspace.create(size)
  const b = await client.tab.open({ runspaceId, ...size })
  const c = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)

  await store.set(reorderTabsAtom, c.id, a.id)

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([
    c.id,
    a.id,
    b.id,
  ])
})

test('dropping the active Tab on another Runspace moves it to the end there, and the view follows it', async () => {
  const { client, store } = bench()
  const from = await client.runspace.create(size)
  const kept = await client.tab.open({ runspaceId: from.runspaceId, ...size })
  const to = await client.runspace.create(size)
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, from.tab.id)

  await store.set(moveTabToRunspaceAtom, from.tab.id, to.runspaceId)

  expect(
    (await client.layout.get()).runspaces.map((r) => ({ id: r.id, tabs: r.tabs.map((t) => t.id) })),
  ).toEqual([
    { id: from.runspaceId, tabs: [kept.id] },
    { id: to.runspaceId, tabs: [to.tab.id, from.tab.id] },
  ])
  expect(store.get(activeRunspaceAtom)?.id).toBe(to.runspaceId)
  expect(store.get(activeTerminalTabAtom)?.id).toBe(from.tab.id)
})

test('the view follows the front Tab when the Backend moves it to another Runspace on its own, as an Attach does', async () => {
  const { db, workbench, client, store } = bench()
  const from = await client.runspace.create(size)
  // 移った後に先頭に残る Runspace。ついていかなければ画面はここに落ちる。
  await client.runspace.create(size)
  const owned = db.transaction((tx) => workbench.createRunspace(tx, { cwd: '/work/bench' }))
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, from.tab.id)

  db.transaction((tx) => workbench.moveTab(tx, from.tab.id, owned))
  await store.set(reloadAtom)

  expect(store.get(activeRunspaceAtom)?.id).toBe(owned)
  expect(store.get(activeTerminalTabAtom)?.id).toBe(from.tab.id)
})

test('pinning the front Tab of a Runspace with siblings follows it into its own Runspace atop the sidebar, and pinning again unpins it', async () => {
  const { client, store } = bench()
  const shells = await client.runspace.create(size)
  const pinned = await client.tab.open({ runspaceId: shells.runspaceId, ...size })
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, pinned.id)

  await store.set(toggleTabPinAtom)

  const split = store.get(activeRunspaceAtom)!
  expect(split.id).not.toBe(shells.runspaceId)
  expect(store.get(activeTerminalTabAtom)?.id).toBe(pinned.id)
  expect(store.get(runspaceSummariesAtom).map((s) => [s.id, s.holdsPin])).toEqual([
    [split.id, true],
    [shells.runspaceId, false],
  ])

  await store.set(toggleTabPinAtom)

  expect(store.get(runspaceSummariesAtom).map((s) => [s.id, s.holdsPin])).toEqual([
    [shells.runspaceId, false],
    [split.id, false],
  ])
})

test('cycling Runspaces follows the sidebar, where the Runspaces holding a pin come first', async () => {
  const { client, store } = bench()
  const [a, p, b] = [
    await client.runspace.create(size),
    await client.runspace.create(size),
    await client.runspace.create(size),
  ]
  await client.tab.pin({ id: p!.tab.id })
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, a!.runspaceId)
  const visited = () => {
    store.set(cycleRunspaceAtom, 'down')
    return store.get(activeRunspaceAtom)?.id
  }

  expect([visited(), visited(), visited()]).toEqual([b!.runspaceId, p!.runspaceId, a!.runspaceId])
})

test('a Runspace moves only within its sidebar group, by drag or by key', async () => {
  const { client, store } = bench()
  const [a, p, b] = [
    await client.runspace.create(size),
    await client.runspace.create(size),
    await client.runspace.create(size),
  ].map((r) => r.runspaceId)
  await client.tab.pin({ id: (await client.layout.get()).runspaces[1]!.tabs[0]!.id })
  await store.set(reloadAtom)
  const books = async () => (await client.layout.get()).runspaces.map((r) => r.id)
  const sidebar = () => store.get(runspaceSummariesAtom).map((s) => s.id)

  await store.set(reorderRunspacesAtom, a!, p!)
  expect(await books()).toEqual([a, p, b])

  store.set(activateRunspaceAtom, b!)
  await store.set(moveActiveRunspaceAtom, 'up')
  expect(sidebar()).toEqual([p, b, a])

  await store.set(moveActiveRunspaceAtom, 'up')
  expect(sidebar()).toEqual([p, b, a])
})

test('a Tab whose shell exits while it is connected closes without ever showing the exit', async () => {
  const { client, store } = bench()
  const { runspaceId, tab: a } = await client.runspace.create(size)
  const b = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)

  // Shell が Exit を受けた時点では、Backend はまだ exit を記録していない。
  const closing = store.set(tabExitedAtom, b.id, b.terminalSessionId, 0)
  expect(store.get(terminalSessionStatusAtom)[b.terminalSessionId]?.status).toBe('exited')
  expect(store.get(deadTabsAtom)).toEqual({})
  await closing

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id])
  expect(store.get(terminalSessionStatusAtom)[b.terminalSessionId]?.status).toBe('exited')
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([])
  expect(shellCalls.map((c) => c.command)).not.toContain('terminal_detach')
})

test('a pinned Tab whose shell exits while it is connected stays open, without an error, for the Backend to respawn', async () => {
  const { client, store } = bench()
  const { tab } = await client.runspace.create(size)
  await client.tab.pin({ id: tab.id })
  await store.set(reloadAtom)

  await store.set(tabExitedAtom, tab.id, tab.terminalSessionId, 0)

  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([tab.id])
  expect(toasts).toEqual([])
})

test('an Exit that arrives after the Tab was bound to a new shell leaves the new shell alone', async () => {
  const { ptyd, client, store } = bench()
  const { tab } = await client.runspace.create(size)
  await client.tab.pin({ id: tab.id })
  ptyd.exit(tab.terminalSessionId, 0)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)
  const respawned = await client.tab.respawn({ id: tab.id, ...size })
  await store.set(reloadAtom)

  await store.set(tabExitedAtom, tab.id, tab.terminalSessionId, 0)

  expect(store.get(deadTabsAtom)).toEqual({})
  expect(store.get(terminalSessionStatusAtom)[respawned.terminalSessionId]?.status).toBe('running')
})

test("Terminate kills the Tab's Terminal Session and closes the Tab, without passing through Detached", async () => {
  const { ptyd, client, store } = bench()
  const { runspaceId, tab: a } = await client.runspace.create(size)
  const b = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)

  await store.set(terminateTabTerminalSessionAtom, b.id)

  await ptyd.received((op) => op.op === 'terminate' && op.session_id === b.terminalSessionId)
  expect((await client.layout.get()).runspaces[0]!.tabs.map((t) => t.id)).toEqual([a.id])
  // ptyd がまだ exit を報告していないので、行は live のまま Tab を失っている。
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([])
})

test('a Terminate that does not reach the Backend leaves the Tab connected to its shell', async () => {
  const { client, store } = bench()
  const { tab } = await client.runspace.create(size)
  await store.set(reloadAtom)
  openTabConnection(tab.id)
  store.set(workbenchClientAtom, null)

  await store.set(terminateTabTerminalSessionAtom, tab.id)

  expect(getTabConnection(tab.id)).toBeDefined()
})

test('New shell binds a Tab whose shell exited to a new running Terminal Session', async () => {
  const { ptyd, client, store } = bench()
  const { tab } = await client.runspace.create(size)
  ptyd.exit(tab.terminalSessionId, 1)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)
  await store.set(reloadAtom)
  expect(store.get(terminalSessionStatusAtom)[tab.terminalSessionId]).toEqual({
    status: 'exited',
    exitCode: 1,
  })

  expect(store.get(deadTabsAtom)[tab.id]).toEqual({ status: 'exited', exitCode: 1 })

  await store.set(startNewShellForTabAtom, tab.id)

  const now = (await client.layout.get()).runspaces[0]!.tabs[0]!
  expect(now.id).toBe(tab.id)
  expect(now.terminalSessionId).not.toBe(tab.terminalSessionId)
  expect(store.get(terminalSessionStatusAtom)[now.terminalSessionId]?.status).toBe('running')
  expect(store.get(deadTabsAtom)).toEqual({})
})

test('a detached Terminal Session sits in the Detached group until it is reattached into the active Runspace', async () => {
  const { client, store } = bench()
  const { runspaceId } = await client.runspace.create(size)
  const closed = await client.tab.open({ runspaceId, ...size })
  await client.tab.close({ id: closed.id })
  const other = await client.runspace.create(size)
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, other.runspaceId)
  expect(store.get(detachedTerminalSessionsAtom).map((s) => s.id)).toEqual([
    closed.terminalSessionId,
  ])

  await store.set(reattachTerminalSessionAtom, closed.terminalSessionId)

  expect(store.get(detachedTerminalSessionsAtom)).toEqual([])
  expect((await client.layout.get()).runspaces[1]!.tabs.map((t) => t.terminalSessionId)).toEqual([
    other.tab.terminalSessionId,
    closed.terminalSessionId,
  ])
  expect(store.get(activeTerminalTabAtom)?.terminalSessionId).toBe(closed.terminalSessionId)
})

test('Kill in the Detached group terminates the Terminal Session', async () => {
  const { ptyd, client, store } = bench()
  const { runspaceId } = await client.runspace.create(size)
  const closed = await client.tab.open({ runspaceId, ...size })
  await client.tab.close({ id: closed.id })
  await store.set(reloadAtom)

  await store.set(terminateTerminalSessionAtom, closed.terminalSessionId)

  await ptyd.received((op) => op.op === 'terminate' && op.session_id === closed.terminalSessionId)
  expect(store.get(detachedTerminalSessionsAtom)).toEqual([])
})

test("the shell's cwd reaches the Backend only when it differs from the last one", async () => {
  const { workbench, client, store } = bench()
  const { tab } = await client.runspace.create({ cwd: '/a', ...size })
  await store.set(reloadAtom)
  let layoutChanges = 0
  const controller = new AbortController()
  void (async () => {
    for await (const change of workbench.events.subscribe('change', controller)) {
      if (change.type === 'layout') layoutChanges++
    }
  })().catch(() => {})

  for (const cwd of ['/a', '/b', '/b', '/c', '/c']) await store.set(updateTabCwdAtom, tab.id, cwd)

  expect((await client.layout.get()).runspaces[0]!.tabs[0]!.cwd).toBe('/c')
  expect(layoutChanges).toBe(2)
  controller.abort()
})

test('a path in the title moves the cwd until the shell reports its cwd itself', async () => {
  const { client, store } = bench()
  const { tab } = await client.runspace.create({ cwd: '/a', ...size })
  await store.set(reloadAtom)
  const cwd = async () => (await client.layout.get()).runspaces[0]!.tabs[0]!.cwd

  await store.set(updateTabTitleAtom, tab.id, '~/repo')
  expect(await cwd()).toBe(join(homedir(), 'repo'))

  await store.set(updateTabCwdAtom, tab.id, '/b')
  await store.set(updateTabTitleAtom, tab.id, '~/c')
  expect(await cwd()).toBe('/b')
})

test('a Runspace is titled repo:branch while its active Tab is in a linked worktree, and by the end of its cwd otherwise', async () => {
  const { client, store } = bench()
  const { root, repo, worktree } = linkedWorktree({ repo: 'acme', branch: 'feature/title' })
  await client.runspace.create({ cwd: worktree, ...size })
  await client.runspace.create({ cwd: repo, ...size })

  await store.set(reloadAtom)

  // worktree の判定は Backend への問い合わせを待つので、cwd の末尾の title から変わるまで待つ。
  const resolved = until(
    store,
    runspaceSummariesAtom,
    (runspaces) => runspaces[0]?.title !== `${basename(root)}/worktree`,
  )
  expect(await resolved).toMatchObject([
    { title: 'acme:feature/title' },
    { title: `${basename(root)}/acme` },
  ])
})

test('a branch switched in a terminal that reports nothing reaches the title on a layout reload 5 seconds later', async () => {
  const { client, store } = bench()
  const { worktree } = linkedWorktree({ repo: 'acme', branch: 'feature/title' })
  await client.runspace.create({ cwd: worktree, ...size })
  await store.set(reloadAtom)
  await until(store, runspaceSummariesAtom, (r) => r[0]?.title === 'acme:feature/title')

  git(worktree, 'switch', '--quiet', '-c', 'feature/renamed')
  setSystemTime(new Date(Date.now() + 5000))
  await store.set(reloadAtom)

  expect(
    await until(store, runspaceSummariesAtom, (r) => r[0]?.title !== 'acme:feature/title'),
  ).toMatchObject([{ title: 'acme:feature/renamed' }])
})

test('a title in a ~ form the Backend cannot make absolute does not move the cwd', async () => {
  const { client, store } = bench()
  const { tab } = await client.runspace.create({ cwd: '/a', ...size })
  await store.set(reloadAtom)

  await store.set(updateTabTitleAtom, tab.id, '~work/repo')
  await store.set(updateTabTitleAtom, tab.id, '~other')

  expect((await client.layout.get()).runspaces[0]!.tabs[0]!.cwd).toBe('/a')
})
