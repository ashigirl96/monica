import { afterEach, expect, test } from 'bun:test'

import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

function setupWithOwned() {
  const booted = setup()
  const { db, workbench } = booted
  const owned = db.transaction((tx) => workbench.createRunspace(tx, { cwd: '/work/bench' }))
  return { ...booted, owned }
}

test('createRunspace makes an owned Runspace with no Tab at the end, and runspace.create one that is not owned', async () => {
  const { db, workbench, client } = setup()
  const plain = await client.runspace.create({ cwd: '/work', ...size })

  const owned = db.transaction((tx) => workbench.createRunspace(tx, { cwd: '/work/bench' }))

  expect((await client.layout.get()).runspaces).toEqual([
    { id: plain.runspaceId, cwd: '/work', sortOrder: 0, owned: false, tabs: [plain.tab] },
    { id: owned, cwd: '/work/bench', sortOrder: 1, owned: true, tabs: [] },
  ])
})

test('an owned Runspace stays when its last Tab closes', async () => {
  const { client, owned } = setupWithOwned()
  const tab = await client.tab.open({ runspaceId: owned, ...size })

  await client.tab.close({ id: tab.id })

  expect((await client.layout.get()).runspaces).toEqual([
    { id: owned, cwd: '/work/bench', sortOrder: 0, owned: true, tabs: [] },
  ])
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
