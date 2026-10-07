import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { defaultGhq, type Ghq } from './ghq.ts'
import { repoCandidates } from './repo.ts'

export type Db = BunSQLiteDatabase

export type NoteLedger = {
  start(): void
  stop(): void
  repoCandidates(): Promise<string[]>
}

export function createNoteLedger(deps: { db: Db; home: string; ghq?: Ghq }): NoteLedger {
  const ghq = deps.ghq ?? defaultGhq
  return {
    start() {},
    stop() {},
    repoCandidates: () => repoCandidates(deps.db, ghq),
  }
}
