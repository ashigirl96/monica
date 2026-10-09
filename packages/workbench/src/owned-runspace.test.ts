import { afterEach, expect, test } from 'bun:test'

import type { WorkbenchChange } from './contract.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

function setupWithOwned() {
  const booted = setup()
  const { db, workbenchLedger } = booted
  const owned = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work/bench' }))
  return { ...booted, owned }
}

test('createRunspace makes an owned Runspace with no Tab at the end, and runspace.create one that is not owned', async () => {
  const { db, workbenchLedger, client } = setup()
  const plain = await client.runspace.create({ cwd: '/work', ...size })

  const owned = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work/bench' }))

  expect((await client.layout.get()).runspaces).toEqual([
    { id: plain.runspaceId, cwd: '/work', sortOrder: 0, owned: false, tabs: [plain.tab] },
    { id: owned, cwd: '/work/bench', sortOrder: 1, owned: true, tabs: [] },
  ])
})

test('createRunspace signals the layout once, so the webview reads a Bench another domain made', () => {
  const { db, workbenchLedger } = setup()
  const changes: WorkbenchChange[] = []
  workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work/bench' }))

  expect(changes).toEqual([{ type: 'layout' }])
})

test('an owned Runspace stays when its last Tab closes, and tab.close names it as left with no Tabs', async () => {
  const { client, owned } = setupWithOwned()
  const tab = await client.tab.open({ runspaceId: owned, ...size })

  expect(await client.tab.close({ id: tab.id })).toEqual({ emptiedRunspaceId: owned })

  expect((await client.layout.get()).runspaces).toEqual([
    { id: owned, cwd: '/work/bench', sortOrder: 0, owned: true, tabs: [] },
  ])
})

test('tab.close names no Runspace when Tabs stay there, or when the Runspace is not owned and goes away', async () => {
  const { client, owned } = setupWithOwned()
  const a = await client.tab.open({ runspaceId: owned, ...size })
  await client.tab.open({ runspaceId: owned, ...size })
  const lone = await client.runspace.create(size)

  expect(await client.tab.close({ id: a.id })).toEqual({ emptiedRunspaceId: null })
  expect(await client.tab.close({ id: lone.tab.id })).toEqual({ emptiedRunspaceId: null })
})

test('an owned Runspace stays when its last Tab moves out', async () => {
  const { client, owned } = setupWithOwned()
  const tab = await client.tab.open({ runspaceId: owned, ...size })
  const other = await client.runspace.create(size)

  await client.tab.move({ id: tab.id, runspaceId: other.runspaceId, index: 1 })

  const { runspaces } = await client.layout.get()
  expect(runspaces.map((r) => ({ id: r.id, tabs: r.tabs.map((t) => t.id) }))).toEqual([
    { id: owned, tabs: [] },
    { id: other.runspaceId, tabs: [other.tab.id, tab.id] },
  ])
})

test('runspace.remove refuses an owned Runspace', async () => {
  const { client, owned } = setupWithOwned()
  await client.tab.open({ runspaceId: owned, ...size })

  await expect(client.runspace.remove({ id: owned })).rejects.toMatchObject({ code: 'CONFLICT' })

  expect((await client.layout.get()).runspaces).toMatchObject([{ id: owned, tabs: [{}] }])
})

test('pinning a Tab of an owned Runspace pins it in place even when it has siblings', async () => {
  const { client, owned } = setupWithOwned()
  const first = await client.tab.open({ runspaceId: owned, ...size })
  const second = await client.tab.open({ runspaceId: owned, ...size })

  await client.tab.pin({ id: second.id })

  expect((await client.layout.get()).runspaces).toMatchObject([
    {
      id: owned,
      tabs: [
        { id: first.id, pinned: false },
        { id: second.id, pinned: true },
      ],
    },
  ])
})
