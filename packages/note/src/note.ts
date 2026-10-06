import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

export type Db = BunSQLiteDatabase

export type NoteLedger = {
  start(): void
  stop(): void
}

export function createNoteLedger(_deps: { db: Db; home: string }): NoteLedger {
  return {
    start() {},
    stop() {},
  }
}
