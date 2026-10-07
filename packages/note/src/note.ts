import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { LinkMetadata } from './contract.ts'
import { defaultGhq, type Ghq } from './ghq.ts'
import { readLinkMetadata } from './link-metadata.ts'
import { repoCandidates } from './repo.ts'

export type Db = BunSQLiteDatabase

export type NoteLedger = {
  start(): void
  stop(): void
  repoCandidates(): Promise<string[]>
  linkMetadata(url: string): Promise<LinkMetadata>
}

export function createNoteLedger(deps: { db: Db; home: string; ghq?: Ghq }): NoteLedger {
  const ghq = deps.ghq ?? defaultGhq
  const stopped = new AbortController()
  return {
    start() {},
    stop() {
      stopped.abort()
    },
    repoCandidates: () => repoCandidates(deps.db, ghq),
    linkMetadata: (url) => readLinkMetadata(url, stopped.signal),
  }
}
