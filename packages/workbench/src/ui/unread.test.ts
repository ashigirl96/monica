import { afterEach, expect, test } from 'bun:test'

import { createStore, type Store } from 'jotai'

import { cleanUp, onCleanup, setup, until } from '../testing.ts'
import type { SidebarRow } from './sidebar-model.ts'
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeTerminalTabAtom,
  agentSessionByTerminalSessionAtom,
  benchLabelOfAtom,
  reloadAgentSessionsAtom,
  reloadAtom,
  sidebarAtom,
  unreadOfTerminalSessionAtom,
  workbenchClientAtom,
} from './store.ts'
import { markSeenWhileShown, windowFocusedAtom } from './unread.ts'

const size = { rows: 24, cols: 80 }

afterEach(cleanUp)

// Workbench は Workbench Ledger の合図のたびに Agent Session を読み直す。
function bench({ focused }: { focused: boolean }) {
  const backend = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => backend.client)
  store.set(windowFocusedAtom, focused)
  onCleanup(
    backend.workbenchLedger.events.subscribe(
      'change',
      () => void store.set(reloadAgentSessionsAtom),
    ),
  )
  onCleanup(markSeenWhileShown(store))
  const record = (terminalSessionId: string, hookEventName: string, fields: object = {}) =>
    backend.client.agentSession.recordHook({
      terminalSessionId,
      payload: {
        session_id: `s-${terminalSessionId}`,
        cwd: '/work',
        hook_event_name: hookEventName,
        ...fields,
      },
    })
  return { ...backend, store, record }
}

function untilUnread(store: Store, terminalSessionId: string, unread: boolean) {
  return until(
    store,
    unreadOfTerminalSessionAtom,
    (isUnread) => isUnread(terminalSessionId) === unread,
  )
}

function rowsOf(store: Store): SidebarRow[] {
  return store.get(sidebarAtom).tiles.flatMap((tile) => tile.sections.flatMap((s) => s.rows))
}

function unreadCountsOfRows(store: Store) {
  return rowsOf(store).map((row) => ({ id: row.id, unreadCount: row.unreadCount }))
}

function seenAtOf(store: Store, terminalSessionId: string) {
  return store.get(agentSessionByTerminalSessionAtom).get(terminalSessionId)?.seenAt
}

test("two permissions asked behind the front Tab mark that Tab unread and count once on its Runspace's row", async () => {
  const { client, store, record } = bench({ focused: true })
  const { runspaceId, tab: front } = await client.runspace.create(size)
  const behind = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, front.id)

  await record(behind.terminalSessionId, 'PermissionRequest', { tool_name: 'Bash' })
  await record(behind.terminalSessionId, 'PermissionRequest', { tool_name: 'Edit' })
  await untilUnread(store, behind.terminalSessionId, true)
  await store.set(reloadAgentSessionsAtom)

  expect(unreadCountsOfRows(store)).toEqual([{ id: runspaceId, unreadCount: 1 }])
  expect(seenAtOf(store, behind.terminalSessionId)).toBeNull()
})

test('showing an unread Tab while the window is in front clears it', async () => {
  const { client, store, record } = bench({ focused: true })
  const { runspaceId, tab: front } = await client.runspace.create(size)
  const behind = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, front.id)
  await record(behind.terminalSessionId, 'Stop')
  await untilUnread(store, behind.terminalSessionId, true)

  store.set(activateTerminalTabAtom, behind.id)

  await untilUnread(store, behind.terminalSessionId, false)
  expect(unreadCountsOfRows(store)).toEqual([{ id: runspaceId, unreadCount: 0 }])
})

test('a Tab seen while its claude still waits leaves the unread count of its row but stays among its dots', async () => {
  const { client, store, record } = bench({ focused: true })
  const { runspaceId, tab: front } = await client.runspace.create(size)
  const behind = await client.tab.open({ runspaceId, ...size })
  await store.set(reloadAtom)
  store.set(activateTerminalTabAtom, front.id)
  await record(behind.terminalSessionId, 'PermissionRequest', { tool_name: 'Bash' })
  await untilUnread(store, behind.terminalSessionId, true)

  store.set(activateTerminalTabAtom, behind.id)
  await untilUnread(store, behind.terminalSessionId, false)

  expect(rowsOf(store)).toMatchObject([
    { id: runspaceId, unreadCount: 0, agentTallies: [{ kind: 'questionOrPermission', count: 1 }] },
  ])
})

test("a Bench's Tab seen while its claude still waits leaves the unread count but keeps its dot on the row", async () => {
  const { db, workbenchLedger, client, store, record } = bench({ focused: true })
  const runspaceId = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
  const { terminalSessionId } = await client.tab.open({ runspaceId, ...size })
  const label = { repo: 'acme/app', number: 12, title: 'Ship it', setup: null }
  store.set(benchLabelOfAtom, () => (id: string) => (id === runspaceId ? label : null))
  await store.set(reloadAtom)

  await record(terminalSessionId, 'PermissionRequest', { tool_name: 'Bash' })
  await untilUnread(store, terminalSessionId, true)
  await untilUnread(store, terminalSessionId, false)

  expect(rowsOf(store)).toMatchObject([{ id: runspaceId, unreadCount: 0, agentDot: 'permission' }])
})

test('a notification for the Tab shown in the front window is seen at once', async () => {
  const { client, store, record } = bench({ focused: true })
  const { tab } = await client.runspace.create(size)
  await store.set(reloadAtom)

  await record(tab.terminalSessionId, 'Stop')

  await until(store, agentSessionByTerminalSessionAtom, () =>
    Boolean(seenAtOf(store, tab.terminalSessionId)),
  )
  expect(store.get(unreadOfTerminalSessionAtom)(tab.terminalSessionId)).toBe(false)
})

test('a notification for the shown Tab while the window is behind stays unread until the window comes to the front', async () => {
  const { client, store, record } = bench({ focused: false })
  const { tab } = await client.runspace.create(size)
  await store.set(reloadAtom)
  await record(tab.terminalSessionId, 'Stop')
  await untilUnread(store, tab.terminalSessionId, true)
  await store.set(reloadAgentSessionsAtom)
  expect(seenAtOf(store, tab.terminalSessionId)).toBeNull()

  store.set(windowFocusedAtom, true)

  await untilUnread(store, tab.terminalSessionId, false)
})

test("pressing a Runspace's row opens its leftmost unread Tab rather than the one last shown", async () => {
  const { client, store, record } = bench({ focused: false })
  const { runspaceId, tab: lastShown } = await client.runspace.create(size)
  const left = await client.tab.open({ runspaceId, ...size })
  const right = await client.tab.open({ runspaceId, ...size })
  const other = await client.runspace.create(size)
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, runspaceId)
  store.set(activateTerminalTabAtom, lastShown.id)
  store.set(activateRunspaceAtom, other.runspaceId)
  await record(right.terminalSessionId, 'Stop')
  await record(left.terminalSessionId, 'Stop')
  await untilUnread(store, left.terminalSessionId, true)
  await untilUnread(store, right.terminalSessionId, true)

  store.set(activateRunspaceAtom, runspaceId)

  expect(store.get(activeTerminalTabAtom)?.id).toBe(left.id)
})

test("pressing a Runspace's row with no unread Tab opens the one last shown", async () => {
  const { client, store } = bench({ focused: true })
  const { runspaceId } = await client.runspace.create(size)
  const lastShown = await client.tab.open({ runspaceId, ...size })
  const other = await client.runspace.create(size)
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, runspaceId)
  store.set(activateTerminalTabAtom, lastShown.id)
  store.set(activateRunspaceAtom, other.runspaceId)

  store.set(activateRunspaceAtom, runspaceId)

  expect(store.get(activeTerminalTabAtom)?.id).toBe(lastShown.id)
})
