import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { createNoteLedger, migrations, router } from './server.ts'

/** in-memory の SQLite に載せた Backend の client。ui のテストは bun:sqlite と server を直に import できない。 */
export function inMemoryNoteClient() {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const noteLedger = createNoteLedger({ db, home: tmpdir() })
  return createRouterClient(router, { context: { db, noteLedger } })
}
