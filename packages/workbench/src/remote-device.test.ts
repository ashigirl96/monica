import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { remoteDevice } from './schema.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

test('registered devices retain their source and revocation without changing the layout', async () => {
  const { db, client, restartBackend } = setup()
  await client.runspace.create({ cwd: '/work', rows: 24, cols: 80 })
  const before = await client.layout.get()
  db.insert(remoteDevice)
    .values({
      id: 'device-1',
      name: 'iPhone',
      secretHash: 'a'.repeat(64),
      sourceAddress: '192.0.2.2',
      revokedAt: null,
    })
    .run()
  db.update(remoteDevice)
    .set({ revokedAt: new Date(1234) })
    .where(eq(remoteDevice.id, 'device-1'))
    .run()
  const restarted = restartBackend()
  expect(db.select().from(remoteDevice).all()).toEqual([
    {
      id: 'device-1',
      name: 'iPhone',
      secretHash: 'a'.repeat(64),
      sourceAddress: '192.0.2.2',
      revokedAt: new Date(1234),
    },
  ])
  expect(await restarted.client.layout.get()).toEqual(before)
})

test('the registration migration preserves populated Layout and Terminal Session rows from the preceding schema', async () => {
  const { Database } = await import('bun:sqlite')
  const { cpSync, readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { drizzle } = await import('drizzle-orm/bun-sqlite')
  const { migrate } = await import('drizzle-orm/bun-sqlite/migrator')
  const { createRouterClient } = await import('@orpc/server')
  const { createWorkbenchLedger, migrations, router } = await import('./server.ts')
  const { terminalSession } = await import('./schema.ts')
  const { onCleanup } = await import('./testing.ts')
  const f = setup()
  const previous = join(f.home, 'previous-migrations')
  cpSync(migrations.folder, previous, { recursive: true })
  const journal = JSON.parse(readFileSync(join(previous, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number }[]
  }
  journal.entries = journal.entries.filter((entry) => entry.idx < 6)
  writeFileSync(join(previous, 'meta', '_journal.json'), JSON.stringify(journal))
  const sqlite = new Database(':memory:')
  onCleanup(() => sqlite.close())
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: previous, migrationsTable: migrations.table })
  const ledger = createWorkbenchLedger({
    db,
    home: f.home,
    ptydPath: join(f.home, 'no-ptyd'),
    notify: () => {},
    nameAgentSession: () => null,
    unread: () => {},
  })
  onCleanup(() => ledger.stop())
  const client = createRouterClient(router, { context: { db, workbenchLedger: ledger } })
  await client.runspace.create({ cwd: '/existing-work', rows: 31, cols: 97 })
  const layout = await client.layout.get()
  const terminals = db.select().from(terminalSession).all()
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  expect(await client.layout.get()).toEqual(layout)
  expect(db.select().from(terminalSession).all()).toEqual(terminals)
  expect(db.select().from(remoteDevice).all()).toEqual([])
})
