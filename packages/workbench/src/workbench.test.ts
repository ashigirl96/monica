import { afterEach, expect, expectTypeOf, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import type { WorkbenchChange } from './contract.ts'
import { startFakePtyd } from './fake-ptyd.ts'
import type { SessionInfo } from './ptyd.ts'
import { runspace, tab as tabTable, terminalSession } from './schema.ts'
import type { Db, WorkbenchLedger } from './server.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

afterEach(cleanUp)

function heldByPtyd(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: id,
    running: true,
    attached: false,
    pid: 4242,
    exit_code: null,
    cwd: '/tmp/somewhere',
    rows: 24,
    cols: 80,
    ...overrides,
  }
}

function rowOf(db: Db, id: string) {
  return db.select().from(terminalSession).where(eq(terminalSession.id, id)).get()
}

type Status = (typeof terminalSession.$inferSelect)['status']

function seedRow(db: Db, id: string, status: Status) {
  db.insert(terminalSession)
    .values({
      id,
      cwd: '/tmp/somewhere',
      shell: '/bin/zsh',
      status,
      pid: 1,
      createdAt: new Date(0),
    })
    .run()
}

// reconcile は Tab の無い live な行を終わらせるので、残す行は Tab に表示させておく。
function seedRowInTab(db: Db, id: string) {
  seedRow(db, id, 'running')
  const runspaceId = `rs-${id}`
  db.insert(runspace).values({ id: runspaceId, cwd: '/tmp/somewhere', sortOrder: 0 }).run()
  db.insert(tabTable)
    .values({
      id: `tab-${id}`,
      runspaceId,
      cwd: '/tmp/somewhere',
      sortOrder: 0,
      terminalSessionId: id,
    })
    .run()
}

test('a live row ptyd no longer holds turns lost', async () => {
  const { db, workbenchLedger, client } = setup()
  seedRow(db, 'ts-gone', 'running')

  await workbenchLedger.start()

  expect(rowOf(db, 'ts-gone')).toMatchObject({ status: 'lost', endedAt: expect.any(Date) })
  expect(await client.terminalSession.list()).toEqual([])
})

test('a live row whose shell died meanwhile turns exited with the code, then its tombstone is reaped', async () => {
  const { ptyd, db, workbenchLedger, client } = setup()
  seedRow(db, 'ts-died', 'running')
  ptyd.sessions.push(heldByPtyd('ts-died', { running: false, pid: null, exit_code: 3 }))

  await workbenchLedger.start()

  expect(rowOf(db, 'ts-died')).toMatchObject({ status: 'exited', exitCode: 3 })
  expect(await client.terminalSession.list()).toEqual([])
  await ptyd.received((op) => op.op === 'reap' && op.session_id === 'ts-died')
})

test("a live row a Tab shows keeps running with ptyd's pid, while one no Tab shows is terminated, as when the Backend stopped before sending the Terminate of a closed Tab", async () => {
  const { ptyd, db, workbenchLedger, client, settled } = setup()
  seedRowInTab(db, 'ts-shown')
  seedRow(db, 'ts-tabless', 'running')
  ptyd.sessions.push(heldByPtyd('ts-shown', { pid: 999 }), heldByPtyd('ts-tabless'))

  await workbenchLedger.start()
  // ptyd は 1 本の接続で順に受けるので、後から開いた Tab の Create が届けば、reconcile の Terminate も届いている。
  const { tab } = await client.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
  await settled(tab.terminalSessionId)

  expect(ptyd.receivedAll((op) => op.op === 'terminate').map((op) => op.session_id)).toEqual([
    'ts-tabless',
  ])
  expect(await client.terminalSession.list()).toContainEqual(
    expect.objectContaining({ id: 'ts-shown', status: 'running', pid: 999 }),
  )
})

test("an ended row stays ended; ptyd's session under its id is terminated or reaped", async () => {
  const { ptyd, db, workbenchLedger, client } = setup()
  seedRow(db, 'ts-exited', 'exited')
  seedRow(db, 'ts-lost', 'lost')
  seedRow(db, 'ts-failed', 'failed')
  ptyd.sessions.push(heldByPtyd('ts-exited'))
  ptyd.sessions.push(heldByPtyd('ts-lost', { running: false, pid: null, exit_code: 0 }))

  await workbenchLedger.start()

  expect(rowOf(db, 'ts-exited')?.status).toBe('exited')
  expect(rowOf(db, 'ts-lost')?.status).toBe('lost')
  expect(rowOf(db, 'ts-failed')?.status).toBe('failed')
  expect(await client.terminalSession.list()).toEqual([])
  await ptyd.received((op) => op.op === 'terminate' && op.session_id === 'ts-exited')
  await ptyd.received((op) => op.op === 'reap' && op.session_id === 'ts-lost')
})

test('a tombstone only ptyd knows is reaped without a row', async () => {
  const { ptyd, db, workbenchLedger } = setup()
  ptyd.sessions.push(heldByPtyd('ts-stray', { running: false, pid: null, exit_code: 0 }))

  await workbenchLedger.start()

  expect(rowOf(db, 'ts-stray')).toBeUndefined()
  await ptyd.received((op) => op.op === 'reap' && op.session_id === 'ts-stray')
})

test('an Exit from ptyd turns the row exited with the code and reaps the tombstone', async () => {
  const { ptyd, db, workbenchLedger } = setup()
  seedRowInTab(db, 'ts-a')
  ptyd.sessions.push(heldByPtyd('ts-a'))
  await workbenchLedger.start()

  ptyd.exit('ts-a', 130)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === 'ts-a')

  expect(rowOf(db, 'ts-a')).toMatchObject({ status: 'exited', exitCode: 130 })
})

test('a new Terminal Session runs in ptyd under a ts-<uuidv7> id with the shell fixed at startup', async () => {
  const shell = process.env.SHELL
  onCleanup(() => {
    process.env.SHELL = shell
  })
  process.env.SHELL = '/bin/startup-shell'
  const { ptyd, client, settled } = setup()
  process.env.SHELL = '/bin/later-shell'

  const { tab } = await client.runspace.create({ cwd: '/work', rows: 24, cols: 80 })

  expect(tab.terminalSessionId).toMatch(
    /^ts-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  expect(await settled(tab.terminalSessionId)).toMatchObject({
    status: 'running',
    pid: 1000,
    shell: '/bin/startup-shell',
  })
  expect(ptyd.receivedAll((op) => op.op === 'create')).toMatchObject([
    { session_id: tab.terminalSessionId, shell: '/bin/startup-shell' },
  ])
})

test('a shell that dies before ptyd answers Created stays exited', async () => {
  const { ptyd, client, settled } = setup()
  ptyd.beforeCreated = (op) => [{ type: 'exit', session_id: op.session_id, exit_code: 127 }]

  const { tab } = await client.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
  await ptyd.received((op) => op.op === 'reap')

  expect(await settled(tab.terminalSessionId)).toMatchObject({ status: 'exited', exitCode: 127 })
})

function nextChange(
  workbenchLedger: WorkbenchLedger,
  type: WorkbenchChange['type'],
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = workbenchLedger.events.subscribe('change', (change) => {
      if (change.type !== type) return
      unsubscribe()
      resolve()
    })
  })
}

test('while ptyd is gone the Backend keeps retrying, then reconciles against the new ptyd', async () => {
  const { home, ptyd, db, workbenchLedger } = setup()
  seedRowInTab(db, 'ts-a')
  ptyd.sessions.push(heldByPtyd('ts-a'))
  await workbenchLedger.start()

  const reconciled = nextChange(workbenchLedger, 'reconciled')
  ptyd.stop()
  await Bun.sleep(50)
  const revived = startFakePtyd(home)
  onCleanup(() => revived.stop())
  await reconciled

  expect(rowOf(db, 'ts-a')?.status).toBe('lost')
})

test('changes streams a signal naming the Terminal Session that changed', async () => {
  const { ptyd, db, workbenchLedger, client } = setup()
  seedRowInTab(db, 'ts-a')
  ptyd.sessions.push(heldByPtyd('ts-a'))
  await workbenchLedger.start()

  const changes = await client.changes()
  const next = changes.next()
  ptyd.exit('ts-a', 0)

  expect((await next).value).toEqual({ type: 'terminalSession', id: 'ts-a' })
  await changes.return?.()
})

test('an Exit that arrives while the reconcile waits for List still ends the row', async () => {
  const { ptyd, db, workbenchLedger } = setup()
  seedRowInTab(db, 'ts-a')
  ptyd.sessions.push(heldByPtyd('ts-a'))
  ptyd.beforeList = () => [{ type: 'exit', session_id: 'ts-a', exit_code: 0 }]

  await workbenchLedger.start()
  await ptyd.received((op) => op.op === 'reap' && op.session_id === 'ts-a')

  expect(rowOf(db, 'ts-a')).toMatchObject({ status: 'exited', exitCode: 0 })
})

test('a ptyd that drops the connection mid-handshake leaves a single connection after the retry', async () => {
  const { ptyd, workbenchLedger } = setup()
  ptyd.dropNextList = true

  await workbenchLedger.start()
  await Bun.sleep(100)

  expect(ptyd.connections).toBe(1)
})

test('a live session only ptyd knows is terminated without a row', async () => {
  const { ptyd, db, workbenchLedger, client } = setup()
  ptyd.sessions.push(heldByPtyd('ts-orphan'))

  await workbenchLedger.start()

  await ptyd.received((op) => op.op === 'terminate' && op.session_id === 'ts-orphan')
  expect(rowOf(db, 'ts-orphan')).toBeUndefined()
  expect(await client.terminalSession.list()).toEqual([])
})

test('the WorkbenchLedger exposes events, start, stop and only the methods other domains call', () => {
  expectTypeOf<keyof WorkbenchLedger>().toEqualTypeOf<
    'events' | 'start' | 'stop' | 'createRunspace' | 'openTab' | 'moveTab' | 'removeRunspace'
  >()
})
