import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

export type Db = BunSQLiteDatabase

export type NoteLedger = {
  start(): void
  stop(): void
}

type Internals = {
  stopped: AbortSignal
}

// NoteLedger の型は start / stop だけに保ち、procedure が使う中身は NoteLedger を key にここへ置く。
const internalsOf = new WeakMap<NoteLedger, Internals>()

export function internals(noteLedger: NoteLedger): Internals {
  const found = internalsOf.get(noteLedger)
  if (!found) throw new Error('this NoteLedger was not made by createNoteLedger')
  return found
}

export function createNoteLedger(_deps: { db: Db; home: string }): NoteLedger {
  const stopped = new AbortController()
  const noteLedger: NoteLedger = {
    start() {},
    stop() {
      stopped.abort()
    },
  }
  internalsOf.set(noteLedger, { stopped: stopped.signal })
  return noteLedger
}
