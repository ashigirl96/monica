import { type AnyContractRouter } from '@orpc/contract'
import { traverseContractProcedures } from '@orpc/server'
import { max, sql, sum } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type { Caller, UsageItem } from './contract.ts'
import { usage } from './schema.ts'

export type Db = BunSQLiteDatabase

type CountOptions = {
  path: readonly string[]
  context: { caller: Caller }
  next: () => Promise<unknown>
}

export type UsageLedger = {
  count: (options: CountOptions) => Promise<unknown>
}

type Internals = { list(): UsageItem[] }

// UsageLedger の型は Backend が渡す count だけに保ち、usage.list の中身は UsageLedger を key にここへ置く。
const internalsOf = new WeakMap<UsageLedger, Internals>()

export function internals(usageLedger: UsageLedger): Internals {
  const found = internalsOf.get(usageLedger)
  if (!found) throw new Error('this UsageLedger was not made by createUsageLedger')
  return found
}

export function featuresOf(router: AnyContractRouter): string[] {
  const features: string[] = []
  traverseContractProcedures({ router, path: [] }, ({ path }) => {
    features.push(path.join('.'))
  })
  return features
}

export function createUsageLedger({
  db,
  features,
  now = () => new Date(),
}: {
  db: Db
  features: readonly string[]
  now?: () => Date
}): UsageLedger {
  function record(feature: string, caller: Caller, outcome: 'ok' | 'failed') {
    try {
      db.insert(usage)
        .values({
          feature,
          caller,
          date: localDate(now()),
          ok: outcome === 'ok' ? 1 : 0,
          failed: outcome === 'failed' ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [usage.feature, usage.caller, usage.date],
          set: {
            ok: sql`${usage.ok} + excluded.ok`,
            failed: sql`${usage.failed} + excluded.failed`,
          },
        })
        .run()
    } catch (error) {
      // 数えるための記録なので、書けなくても呼び出しの結果は返す。
      console.error(`[usage] could not count ${feature} by ${caller}: ${(error as Error).message}`)
    }
  }

  const usageLedger: UsageLedger = {
    count: async ({ path, context, next }) => {
      const feature = path.join('.')
      let output: unknown
      try {
        output = await next()
      } catch (error) {
        record(feature, context.caller, 'failed')
        throw error
      }
      record(feature, context.caller, 'ok')
      return output
    },
  }

  internalsOf.set(usageLedger, {
    list() {
      const rows = db
        .select({
          feature: usage.feature,
          caller: usage.caller,
          ok: sum(usage.ok).mapWith(Number),
          failed: sum(usage.failed).mapWith(Number),
          lastUsed: max(usage.date),
        })
        .from(usage)
        .groupBy(usage.feature, usage.caller)
        .all()
      const items = features.flatMap((feature): UsageItem[] => {
        const called = rows.filter((row) => row.feature === feature)
        if (called.length > 0) return called
        return [{ feature, caller: null, ok: 0, failed: 0, lastUsed: null }]
      })
      return items.toSorted(
        (a, b) =>
          compare(a.lastUsed ?? '', b.lastUsed ?? '') ||
          compare(a.feature, b.feature) ||
          compare(a.caller ?? '', b.caller ?? ''),
      )
    },
  })
  return usageLedger
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
