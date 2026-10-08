import { afterEach, expect, spyOn, test } from 'bun:test'

import { startFakePtyd } from './fake-ptyd.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

afterEach(cleanUp)

function setupWithOwned() {
  const booted = setup()
  const { db, workbenchLedger } = booted
  const owned = db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work/bench' }))
  return { ...booted, owned }
}

test("a Tab opened while the reconcile waits for ptyd's List is not lost, and its shell starts once the reconcile ends", async () => {
  const { ptyd, db, workbenchLedger, owned, settled } = setupWithOwned()
  const finishList = ptyd.holdNext('list')
  const starting = workbenchLedger.start()
  await ptyd.received((op) => op.op === 'list')

  const { terminalSessionId } = db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned }),
  )
  finishList()
  await starting

  expect(await settled(terminalSessionId)).toMatchObject({ status: 'running' })
  expect(ptyd.receivedAll((op) => op.op === 'create')).toMatchObject([
    { session_id: terminalSessionId },
  ])
})

test('a transaction that rolls back sends ptyd neither the Create of the Tab it opened nor the Terminate of the Tabs it removed', async () => {
  const { ptyd, db, workbenchLedger, client, owned, settled } = setupWithOwned()
  const kept = db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))
  await settled(kept.terminalSessionId)

  expect(() =>
    db.transaction((tx) => {
      workbenchLedger.openTab(tx, { runspaceId: owned })
      throw new Error('rolled back')
    }),
  ).toThrow('rolled back')
  expect(() =>
    db.transaction((tx) => {
      workbenchLedger.removeRunspace(tx, owned)
      throw new Error('rolled back')
    }),
  ).toThrow('rolled back')
  // ptyd は 1 本の接続で順に受けるので、後から開いた Tab の Create が届けば、先に送られたものも届いている。
  const after = db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))
  await settled(after.terminalSessionId)

  expect(ptyd.receivedAll((op) => op.op === 'create').map((op) => op.session_id)).toEqual([
    kept.terminalSessionId,
    after.terminalSessionId,
  ])
  expect(ptyd.receivedAll((op) => op.op === 'terminate')).toEqual([])
  expect((await client.layout.get()).runspaces[0]?.tabs.map((t) => t.id)).toEqual([
    kept.tabId,
    after.tabId,
  ])
})

test('a Tab committed before the first connection to ptyd dropped gets its Create once after the retry, and its pin does not respawn it', async () => {
  const { ptyd, db, workbenchLedger, client, owned, settled } = setupWithOwned()
  const finishList = ptyd.holdNext('list')
  ptyd.dropNextList = true
  const starting = workbenchLedger.start()
  await ptyd.received((op) => op.op === 'list')
  const opened = db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))
  await client.tab.pin({ id: opened.tabId })

  finishList()
  await starting

  expect(await settled(opened.terminalSessionId)).toMatchObject({ status: 'running' })
  expect(ptyd.receivedAll((op) => op.op === 'create')).toMatchObject([
    { session_id: opened.terminalSessionId },
  ])
  expect((await client.layout.get()).runspaces[0]?.tabs).toMatchObject([
    { id: opened.tabId, terminalSessionId: opened.terminalSessionId, pinned: true },
  ])
})

test('a Tab committed while the Backend reconnects to a ptyd it lost gets its Create once after that reconcile, and its pin does not respawn it', async () => {
  const { ptyd, db, workbenchLedger, client, owned, settled } = setupWithOwned()
  await workbenchLedger.start()
  const finishList = ptyd.holdNext('list')
  ptyd.dropConnections()
  await ptyd.receivedAtLeast(2, (op) => op.op === 'list')
  const opened = db.transaction((tx) => workbenchLedger.openTab(tx, { runspaceId: owned }))
  await client.tab.pin({ id: opened.tabId })

  finishList()

  expect(await settled(opened.terminalSessionId)).toMatchObject({ status: 'running' })
  expect(ptyd.receivedAll((op) => op.op === 'create')).toMatchObject([
    { session_id: opened.terminalSessionId },
  ])
  expect((await client.layout.get()).runspaces[0]?.tabs).toMatchObject([
    { id: opened.tabId, terminalSessionId: opened.terminalSessionId, pinned: true },
  ])
})

test('a Tab whose Created reply is lost to a dropped connection is typed into once the reconcile adopts its shell', async () => {
  const { ptyd, db, workbenchLedger, owned, settled } = setupWithOwned()
  await workbenchLedger.start()
  ptyd.dropNextCreatedReply = true

  const { terminalSessionId } = db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned, input: 'claude\r' }),
  )

  await ptyd.received((op) => op.op === 'write')
  expect(await settled(terminalSessionId)).toMatchObject({ status: 'running' })
  expect(ptyd.sessionRequests()).toEqual([
    expect.objectContaining({ op: 'create', session_id: terminalSessionId }),
    { op: 'write', session_id: terminalSessionId, data: 'claude\r' },
  ])
})

test('while ptyd cannot be reached, opening a Tab returns and leaves it starting; once ptyd is back, its shell starts and the input is typed', async () => {
  const { home, ptyd, db, workbenchLedger, client, owned, settled } = setupWithOwned()
  const failedToConnect = Promise.withResolvers<void>()
  const stderr = spyOn(console, 'error').mockImplementation((line: unknown) => {
    if (String(line).includes('monica-ptyd connection failed')) failedToConnect.resolve()
  })
  onCleanup(() => stderr.mockRestore())
  ptyd.stop()
  const starting = workbenchLedger.start()

  const fromDomain = db.transaction((tx) =>
    workbenchLedger.openTab(tx, { runspaceId: owned, input: 'claude\r' }),
  )
  const fromWebview = await client.tab.open({ runspaceId: owned, rows: 30, cols: 100 })
  await failedToConnect.promise

  expect(await client.terminalSession.list()).toMatchObject([
    { id: fromDomain.terminalSessionId, status: 'starting' },
    { id: fromWebview.terminalSessionId, status: 'starting' },
  ])

  const revived = startFakePtyd(home)
  onCleanup(() => revived.stop())
  await starting
  await revived.received((op) => op.op === 'write')

  expect(await settled(fromDomain.terminalSessionId)).toMatchObject({ status: 'running' })
  expect(await settled(fromWebview.terminalSessionId)).toMatchObject({ status: 'running' })
  expect(revived.sessionRequests()).toEqual([
    expect.objectContaining({ op: 'create', session_id: fromDomain.terminalSessionId }),
    expect.objectContaining({ op: 'create', session_id: fromWebview.terminalSessionId }),
    { op: 'write', session_id: fromDomain.terminalSessionId, data: 'claude\r' },
  ])
})
