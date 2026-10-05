import { afterEach, expect, setSystemTime, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { startFakePtyd } from './fake-ptyd.ts'
import { shouldRespawn } from './pin.ts'
import { runspace, tab as tabTable, terminalSession } from './schema.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

type Client = ReturnType<typeof setup>['client']

// 張り直すのは 2 秒以上生きた shell だけなので、終わらせる前に時計を進める。
function letShellsLive() {
  setSystemTime(new Date(Date.now() + 3000))
  onCleanup(() => setSystemTime())
}

async function layoutWithPins(client: Client) {
  const { runspaces } = await client.layout.get()
  return runspaces.map((r) => ({
    id: r.id,
    tabs: r.tabs.map((t) => (t.pinned ? `${t.id} (pinned)` : t.id)),
  }))
}

test('pinning the only Tab of a Runspace pins it in place', async () => {
  const { client } = setup()
  const { runspaceId, tab } = await client.runspace.create(size)

  await client.tab.pin({ id: tab.id })

  expect(await layoutWithPins(client)).toEqual([{ id: runspaceId, tabs: [`${tab.id} (pinned)`] }])
})

test("pinning a Tab that has siblings splits it into a new last Runspace in the Tab's cwd", async () => {
  const { client } = setup()
  const left = await client.runspace.create({ cwd: '/work', ...size })
  const pinned = await client.tab.open({ runspaceId: left.runspaceId, ...size })
  await client.tab.setCwd({ id: pinned.id, cwd: '/work/sub' })
  const sibling = await client.tab.open({ runspaceId: left.runspaceId, ...size })
  const right = await client.runspace.create(size)

  await client.tab.pin({ id: pinned.id })

  const { runspaces } = await client.layout.get()
  expect(await layoutWithPins(client)).toEqual([
    { id: left.runspaceId, tabs: [left.tab.id, sibling.id] },
    { id: right.runspaceId, tabs: [right.tab.id] },
    { id: expect.any(String), tabs: [`${pinned.id} (pinned)`] },
  ])
  expect(runspaces.map((r) => r.sortOrder)).toEqual([0, 1, 2])
  expect(runspaces[0]?.tabs.map((t) => t.sortOrder)).toEqual([0, 1])
  expect(runspaces[2]).toMatchObject({ cwd: '/work/sub', tabs: [{ sortOrder: 0 }] })
})

test('pinning another Tab of a pinned Runspace moves the pin there without splitting', async () => {
  const { client } = setup()
  const { runspaceId, tab: first } = await client.runspace.create(size)
  await client.tab.pin({ id: first.id })
  const second = await client.tab.open({ runspaceId, ...size })

  await client.tab.pin({ id: second.id })

  expect(await layoutWithPins(client)).toEqual([
    { id: runspaceId, tabs: [first.id, `${second.id} (pinned)`] },
  ])
})

test('a pinned Tab cannot be closed, have its Terminal Session terminated, or go with its Runspace', async () => {
  const { ptyd, client } = setup()
  const { runspaceId, tab } = await client.runspace.create(size)
  await client.tab.pin({ id: tab.id })
  const before = await client.layout.get()

  await expect(client.tab.close({ id: tab.id })).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(
    client.terminalSession.terminate({ id: tab.terminalSessionId }),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(client.runspace.remove({ id: runspaceId })).rejects.toMatchObject({
    code: 'CONFLICT',
  })

  expect(await client.layout.get()).toEqual(before)
  expect(ptyd.receivedAll((op) => op.op === 'terminate')).toEqual([])
})

test('moving a pinned Tab within its Runspace keeps the pin, and into another Runspace drops it', async () => {
  const { client } = setup()
  const { runspaceId, tab: pinned } = await client.runspace.create(size)
  await client.tab.pin({ id: pinned.id })
  const sibling = await client.tab.open({ runspaceId, ...size })
  const other = await client.runspace.create(size)

  await client.tab.move({ id: pinned.id, runspaceId, index: 1 })

  expect(await layoutWithPins(client)).toEqual([
    { id: runspaceId, tabs: [sibling.id, `${pinned.id} (pinned)`] },
    { id: other.runspaceId, tabs: [other.tab.id] },
  ])

  await client.tab.move({ id: pinned.id, runspaceId: other.runspaceId, index: 0 })

  expect(await layoutWithPins(client)).toEqual([
    { id: runspaceId, tabs: [sibling.id] },
    { id: other.runspaceId, tabs: [pinned.id, other.tab.id] },
  ])
})

test('the books refuse a second pinned Tab in one Runspace', async () => {
  const { db, client } = setup()
  const { runspaceId, tab: first } = await client.runspace.create(size)
  const second = await client.tab.open({ runspaceId, ...size })
  const elsewhere = await client.runspace.create(size)
  const markPinned = (id: string) =>
    db.update(tabTable).set({ pinned: true }).where(eq(tabTable.id, id)).run()

  markPinned(first.id)
  markPinned(elsewhere.tab.id)

  expect(() => markPinned(second.id)).toThrow('UNIQUE constraint failed')
})

test('unpinning a split Tab leaves it in its own Runspace', async () => {
  const { client } = setup()
  const { runspaceId, tab: kept } = await client.runspace.create(size)
  const split = await client.tab.open({ runspaceId, ...size })
  await client.tab.pin({ id: split.id })

  await client.tab.unpin({ id: split.id })

  expect(await layoutWithPins(client)).toEqual([
    { id: runspaceId, tabs: [kept.id] },
    { id: expect.any(String), tabs: [split.id] },
  ])
})

test("when a pinned Tab's shell exits, the Backend binds the Tab to a new shell in its last cwd at 24×80", async () => {
  const { ptyd, client, settled } = setup()
  const { runspaceId, tab } = await client.runspace.create({ cwd: '/work', rows: 50, cols: 200 })
  await client.tab.setCwd({ id: tab.id, cwd: '/work/sub' })
  await client.tab.pin({ id: tab.id })
  await settled(tab.terminalSessionId)
  letShellsLive()

  ptyd.exit(tab.terminalSessionId, 0)

  const created = await ptyd.received(
    (op) => op.op === 'create' && op.session_id !== tab.terminalSessionId,
  )
  const { runspaces } = await client.layout.get()
  const respawned = runspaces[0]?.tabs[0]
  expect(runspaces.map((r) => r.id)).toEqual([runspaceId])
  expect(respawned).toEqual({
    ...tab,
    cwd: '/work/sub',
    pinned: true,
    terminalSessionId: expect.any(String),
  })
  expect(created).toMatchObject({
    session_id: respawned?.terminalSessionId,
    cwd: '/work/sub',
    rows: 24,
    cols: 80,
  })
})

test('a pinned Tab whose shell ptyd lost is bound to a new shell after the reconcile', async () => {
  const { home, ptyd, client } = setup()
  const { tab } = await client.runspace.create({ cwd: '/work', ...size })
  await client.tab.pin({ id: tab.id })
  letShellsLive()

  ptyd.stop()
  await Bun.sleep(50)
  const revived = startFakePtyd(home)
  onCleanup(() => revived.stop())

  const created = await revived.received((op) => op.op === 'create')
  const respawned = (await client.layout.get()).runspaces[0]?.tabs[0]
  expect(respawned).toEqual({ ...tab, pinned: true, terminalSessionId: expect.any(String) })
  expect(created).toMatchObject({
    session_id: respawned?.terminalSessionId,
    cwd: '/work',
    rows: 24,
    cols: 80,
  })
})

test('a respawned shell whose Created reply is lost to a dropped connection is adopted by the reconcile, not failed', async () => {
  const { ptyd, workbench, client, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await client.tab.pin({ id: tab.id })
  await settled(tab.terminalSessionId)
  letShellsLive()
  ptyd.dropNextCreatedReply = true
  const reconciled = new Promise<void>((resolve) => {
    const unsubscribe = workbench.events.subscribe('change', (change) => {
      if (change.type !== 'reconciled') return
      unsubscribe()
      resolve()
    })
  })

  ptyd.exit(tab.terminalSessionId, 0)
  await reconciled

  const respawned = (await client.layout.get()).runspaces[0]?.tabs[0]
  expect(respawned?.terminalSessionId).not.toBe(tab.terminalSessionId)
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({ id: respawned?.terminalSessionId, status: 'running' }),
  ])
  expect(ptyd.receivedAll((op) => op.op === 'terminate')).toEqual([])
})

test('a pinned Tab the Backend left on an ended Terminal Session before it stopped is respawned on start', async () => {
  const { ptyd, db, workbench, client } = setup()
  const createdAt = new Date(Date.now() - 60_000)
  db.insert(terminalSession)
    .values({
      id: 'ts-ended',
      cwd: '/work',
      shell: '/bin/zsh',
      status: 'exited',
      exitCode: 0,
      createdAt,
      endedAt: new Date(createdAt.getTime() + 10_000),
    })
    .run()
  db.insert(runspace).values({ id: 'rs-pinned', cwd: '/work', sortOrder: 0 }).run()
  db.insert(tabTable)
    .values({
      id: 'tab-pinned',
      runspaceId: 'rs-pinned',
      cwd: '/work/sub',
      sortOrder: 0,
      terminalSessionId: 'ts-ended',
      pinned: true,
    })
    .run()

  await workbench.start()

  const created = await ptyd.received((op) => op.op === 'create')
  const respawned = (await client.layout.get()).runspaces[0]?.tabs[0]
  expect(respawned).toMatchObject({ id: 'tab-pinned', pinned: true })
  expect(created).toMatchObject({
    session_id: respawned?.terminalSessionId,
    cwd: '/work/sub',
    rows: 24,
    cols: 80,
  })
})

test('a pinned Tab whose shell dies right after starting stays on the ended Terminal Session', async () => {
  const { ptyd, client, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await client.tab.pin({ id: tab.id })
  await settled(tab.terminalSessionId)

  ptyd.exit(tab.terminalSessionId, 1)
  // 張り直すかは Exit を受けた直後に決まり、Reap はその後で ptyd に届く。
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect((await client.layout.get()).runspaces[0]?.tabs).toEqual([{ ...tab, pinned: true }])
  expect(await client.terminalSession.list()).toEqual([
    expect.objectContaining({ id: tab.terminalSessionId, status: 'exited', tabId: tab.id }),
  ])
})

const pinned = { pinned: true }

test.each([
  { status: 'exited', ran: true, lived: 2000, tab: pinned, respawn: true },
  { status: 'lost', ran: true, lived: 60_000, tab: pinned, respawn: true },
  { status: 'exited', ran: true, lived: 1999, tab: pinned, respawn: false },
  { status: 'lost', ran: true, lived: 500, tab: pinned, respawn: false },
  { status: 'lost', ran: false, lived: 500, tab: pinned, respawn: true },
  { status: 'failed', ran: false, lived: 60_000, tab: pinned, respawn: false },
  { status: 'exited', ran: true, lived: 60_000, tab: { pinned: false }, respawn: false },
  { status: 'lost', ran: false, lived: 500, tab: { pinned: false }, respawn: false },
  { status: 'exited', ran: true, lived: 60_000, tab: null, respawn: false },
] as const)(
  'a $status Terminal Session (ran: $ran) that lived $lived ms in Tab $tab respawns: $respawn',
  ({ status, ran, lived, tab, respawn }) => {
    const createdAt = new Date(1_000_000)
    const endedAt = new Date(createdAt.getTime() + lived)
    const pid = ran ? 4242 : null

    expect(shouldRespawn({ status, pid, createdAt, endedAt }, tab)).toBe(respawn)
  },
)
