import { afterEach, expect, test } from 'bun:test'

import type { WorkbenchChange } from './contract.ts'
import type { startFakePtyd } from './fake-ptyd.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

type Ptyd = ReturnType<typeof startFakePtyd>

async function terminated(ptyd: Ptyd, count: number) {
  const ops = await ptyd.receivedAtLeast(count, (op) => op.op === 'terminate')
  return ops.map((op) => op.session_id)
}

function setupWithOwned() {
  const booted = setup()
  const { db, workbenchLedger } = booted
  const owned = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work/bench' }))
  return { ...booted, owned }
}

test("openTab opens a Tab at the end of the Runspace on a starting Terminal Session, in the Runspace's cwd unless given one", async () => {
  const { db, workbenchLedger, client, owned } = setupWithOwned()
  const first = await client.tab.open({ runspaceId: owned, ...size })

  const inBench = db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))
  const elsewhere = db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned, cwd: '/work/bench/app' }),
  )

  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      tabs: [
        { id: first.id },
        { id: inBench.tabId, cwd: '/work/bench', terminalSessionId: inBench.terminalSessionId },
        { id: elsewhere.tabId, cwd: '/work/bench/app' },
      ],
    },
  ])
  expect(
    (await client.terminalSession.list()).find((s) => s.id === elsewhere.terminalSessionId),
  ).toMatchObject({ cwd: '/work/bench/app', status: 'starting' })
})

test('openTab signals the layout, so the webview reads a Tab another domain opened', () => {
  const { db, workbenchLedger, owned } = setupWithOwned()
  const changes: WorkbenchChange[] = []
  workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))

  expect(changes).toEqual([{ type: 'layout' }])
})

test('openTab starts the shell at 24×80 once the transaction commits, then types the input into it without being attached', async () => {
  const { ptyd, db, workbenchLedger, client, owned } = setupWithOwned()
  await workbenchLedger.start()

  const { terminalSessionId } = db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned, input: 'claude\r' }),
  )

  await ptyd.received((op) => op.op === 'write')
  expect(ptyd.sessionRequests()).toEqual([
    expect.objectContaining({
      op: 'create',
      session_id: terminalSessionId,
      cwd: '/work/bench',
      rows: 24,
      cols: 80,
    }),
    { op: 'write', session_id: terminalSessionId, data: 'claude\r' },
  ])
  expect(await client.terminalSession.list()).toMatchObject([
    { id: terminalSessionId, status: 'running' },
  ])
})

test('openTab starts the shell at the size given', async () => {
  const { ptyd, db, workbenchLedger, owned } = setupWithOwned()

  db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned, size: { rows: 50, cols: 120 } }),
  )

  expect(await ptyd.received((op) => op.op === 'create')).toMatchObject({ rows: 50, cols: 120 })
})

test('moveTab moves a Tab to the end of another Runspace, drops its pin, removes the Runspace it emptied, and signals the layout', async () => {
  const { db, workbenchLedger, client, owned } = setupWithOwned()
  const inBench = await client.tab.open({ runspaceId: owned, ...size })
  const elsewhere = await client.runspace.create({ cwd: '/work', ...size })
  await client.tab.pin({ id: elsewhere.tab.id })
  const changes: WorkbenchChange[] = []
  workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  db.transaction((tx) => workbenchLedger.moveTab(tx, elsewhere.tab.id, owned))

  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      tabs: [
        { id: inBench.id, sortOrder: 0 },
        { id: elsewhere.tab.id, sortOrder: 1, pinned: false },
      ],
    },
  ])
  expect(changes).toEqual([{ type: 'layout' }])
})

test('removeRunspace removes the owned Runspace with all its Tabs, pinned ones too, terminates their Terminal Sessions once the transaction commits, and signals the layout', async () => {
  const { ptyd, db, workbenchLedger, client, owned, settled } = setupWithOwned()
  const plain = await client.runspace.create(size)
  const first = await client.tab.open({ runspaceId: owned, ...size })
  const pinned = await client.tab.open({ runspaceId: owned, ...size })
  await client.tab.pin({ id: pinned.id })
  for (const tab of [plain.tab, first, pinned]) await settled(tab.terminalSessionId)
  const changes: WorkbenchChange[] = []
  workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  db.transaction((tx) => workbenchLedger.removeRunspace(tx, owned))

  expect(await terminated(ptyd, 2)).toEqual([first.terminalSessionId, pinned.terminalSessionId])
  expect((await client.layout.get()).runspaces).toMatchObject([
    { id: plain.runspaceId, sortOrder: 0 },
  ])
  expect(changes).toEqual([{ type: 'layout' }])
})

test("removeRunspace keeps the spared Tab, pinned or not, in the Runspace it no longer owns, and terminates only the other Tabs' Terminal Sessions", async () => {
  const { ptyd, db, workbenchLedger, client, owned } = setupWithOwned()
  const other = await client.tab.open({ runspaceId: owned, ...size })
  const spared = await client.tab.open({ runspaceId: owned, ...size })
  await client.tab.pin({ id: spared.id })

  db.transaction((tx) =>
    workbenchLedger.removeRunspace(tx, owned, { spare: [spared.terminalSessionId] }),
  )

  expect(await terminated(ptyd, 1)).toEqual([other.terminalSessionId])
  expect((await client.layout.get()).runspaces).toEqual([
    {
      id: owned,
      cwd: '/work/bench',
      sortOrder: 0,
      owned: false,
      tabs: [{ ...spared, sortOrder: 0, pinned: true }],
    },
  ])
})

test('removeRunspace keeps every spared Tab in their order', async () => {
  const { ptyd, db, workbenchLedger, client, owned } = setupWithOwned()
  const first = await client.tab.open({ runspaceId: owned, ...size })
  const other = await client.tab.open({ runspaceId: owned, ...size })
  const last = await client.tab.open({ runspaceId: owned, ...size })

  db.transaction((tx) =>
    workbenchLedger.removeRunspace(tx, owned, {
      spare: [last.terminalSessionId, first.terminalSessionId],
    }),
  )

  expect(await terminated(ptyd, 1)).toEqual([other.terminalSessionId])
  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      owned: false,
      tabs: [
        { id: first.id, sortOrder: 0 },
        { id: last.id, sortOrder: 1 },
      ],
    },
  ])
})

test('the Runspace a spared Tab stays in goes away with its last Tab, like any other', async () => {
  const { db, workbenchLedger, client, owned } = setupWithOwned()
  const spared = await client.tab.open({ runspaceId: owned, ...size })
  db.transaction((tx) =>
    workbenchLedger.removeRunspace(tx, owned, { spare: [spared.terminalSessionId] }),
  )

  await client.tab.close({ id: spared.id })

  expect((await client.layout.get()).runspaces).toEqual([])
})

test('removeRunspace removes the whole Runspace when the spared Terminal Session is in none of its Tabs', async () => {
  const { ptyd, db, workbenchLedger, client, owned } = setupWithOwned()
  const inBench = await client.tab.open({ runspaceId: owned, ...size })
  const elsewhere = await client.runspace.create(size)

  db.transaction((tx) =>
    workbenchLedger.removeRunspace(tx, owned, { spare: [elsewhere.tab.terminalSessionId] }),
  )

  expect(await terminated(ptyd, 1)).toEqual([inBench.terminalSessionId])
  expect((await client.layout.get()).runspaces.map((r) => r.id)).toEqual([elsewhere.runspaceId])
})
