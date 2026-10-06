import { Database } from 'bun:sqlite'
import { spyOn } from 'bun:test'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from './server.ts'

export function inMemoryDb() {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  return db
}

/** Job Ledger の tick を捕まえ、テストが手で呼ぶ。 */
export function captureInterval() {
  const captured: { tick?: () => void; ms?: number } = {}
  spyOn(globalThis, 'setInterval').mockImplementation(((tick: () => void, ms: number) => {
    Object.assign(captured, { tick, ms })
    return 0
  }) as unknown as typeof setInterval)
  spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
  return captured
}
