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

  expect(await client.tab.close({ id: tab.id })).toEqual({
    tabId: tab.id,
    emptiedRunspaceId: owned,
  })

  expect((await client.layout.get()).runspaces).toEqual([
    { id: owned, cwd: '/work/bench', sortOrder: 0, owned: true, tabs: [] },
  ])
})

test('tab.close names no Runspace when Tabs stay there, or when the Runspace is not owned and goes away', async () => {
  const { workbenchLedger, client, owned } = setupWithOwned()
  const a = await client.tab.open({ runspaceId: owned, ...size })
  await client.tab.open({ runspaceId: owned, ...size })
  const lone = await client.runspace.create(size)
  const changes: WorkbenchChange[] = []
  workbenchLedger.events.subscribe('change', (change) => changes.push(change))

  expect(await client.tab.close({ id: a.id })).toEqual({ tabId: a.id, emptiedRunspaceId: null })
  expect(await client.tab.close({ id: lone.tab.id })).toEqual({
    tabId: lone.tab.id,
    emptiedRunspaceId: null,
  })
  expect(changes.filter((change) => change.type === 'runspaceEmptied')).toEqual([])
})

test.each([
  [
    'its shell exits',
    async ({ ptyd, settled }: ReturnType<typeof setup>, tab: { terminalSessionId: string }) => {
      await settled(tab.terminalSessionId)
      ptyd.exit(tab.terminalSessionId, 0)
      await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)
    },
  ],
  [
    'tab.close closes it, as the CLI does',
    async ({ client }: ReturnType<typeof setup>, tab: { id: string }) => {
      await client.tab.close({ id: tab.id })
    },
  ],
])(
  'when the last Tab of an owned Runspace goes because %s, the Runspace stays with no Tabs and is streamed once as emptied',
  async (_, close) => {
    const booted = setupWithOwned()
    const { workbenchLedger, client, owned } = booted
    const tab = await client.tab.open({ runspaceId: owned, ...size })
    const changes: WorkbenchChange[] = []
    workbenchLedger.events.subscribe('change', (change) => changes.push(change))

    await close(booted, tab)

    expect(changes.filter((change) => change.type === 'runspaceEmptied')).toEqual([
      { type: 'runspaceEmptied', runspaceId: owned },
    ])
    expect((await client.layout.get()).runspaces).toMatchObject([{ id: owned, tabs: [] }])
  },
)

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
