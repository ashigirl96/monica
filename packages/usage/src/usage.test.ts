import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'

import { createRouterClient, type InferRouterInitialContext, ORPCError, os } from '@orpc/server'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { z } from 'zod'

import type { Caller } from './contract.ts'
import { createUsageLedger, featuresOf, migrations, router as usageRouter } from './server.ts'

// context の無い os の procedure を usage の router と混ぜると、router の context が never になる。
const base = os.$context<InferRouterInitialContext<typeof usageRouter>>()

const features = {
  ping: base.handler(() => 'pong'),
  refuse: base.handler(() => {
    throw new ORPCError('NOT_FOUND', { message: 'no such thing' })
  }),
  strict: base.input(z.object({ n: z.number() })).handler(({ input }) => input.n),
  stream: base.handler(async function* () {
    yield 1
    throw new Error('broken in the middle')
  }),
  gone: base.handler(() => 'still served'),
}

function setUp({ now = () => new Date(2026, 9, 11, 12, 0) }: { now?: () => Date } = {}) {
  const db = drizzle(new Database(':memory:'))
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  // gone は Feature の一覧に無い、消した Feature の代わり。
  const { gone: _, ...served } = features
  const router = { ...served, usage: usageRouter }
  const usageLedger = createUsageLedger({ db, features: featuresOf(router), now })
  const context = { db, usageLedger }
  const as = (caller: Caller) =>
    createRouterClient(
      { ...features, usage: usageRouter },
      {
        context,
        // createRouterClient は interceptor の context を型に載せないので、Backend の口が入れる caller をここで足す。
        interceptors: [
          (options) =>
            usageLedger.count({
              path: options.path,
              next: () => options.next(),
              context: { caller },
            }),
        ],
      },
    )
  const list = async () => (await createRouterClient(usageRouter, { context }).list()).usages
  return { db, as, list }
}

test('a call that returns counts as ok for its Feature and Caller', async () => {
  const { as, list } = setUp()

  expect(await as('cli').ping()).toBe('pong')

  expect(await list()).toContainEqual({
    feature: 'ping',
    caller: 'cli',
    ok: 1,
    failed: 0,
    lastUsed: '2026-10-11',
  })
})

test('a procedure that throws an ORPCError and an input that fails validation count as failed, not ok', async () => {
  const { as, list } = setUp()

  expect(as('webview').refuse()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  // @ts-expect-error 検証で落ちる input を送る。
  expect(as('extension').strict({ n: 'one' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await Bun.sleep(0)

  const usages = await list()
  expect(usages).toContainEqual(
    expect.objectContaining({ feature: 'refuse', caller: 'webview', ok: 0, failed: 1 }),
  )
  expect(usages).toContainEqual(
    expect.objectContaining({ feature: 'strict', caller: 'extension', ok: 0, failed: 1 }),
  )
})

test('a stream counts as ok once its iterator returns, even if it fails while streaming', async () => {
  const { as, list } = setUp()

  const values: number[] = []
  const streamed = (async () => {
    for await (const value of await as('notes').stream()) values.push(value)
  })()

  expect(streamed).rejects.toThrow('broken in the middle')
  await streamed.catch(() => {})
  expect(values).toEqual([1])
  expect(await list()).toContainEqual(
    expect.objectContaining({ feature: 'stream', caller: 'notes', ok: 1, failed: 0 }),
  )
})

test('two calls on one day add up in one row, and a call on the next day makes another row', async () => {
  let now = new Date(2026, 9, 11, 0, 0)
  const { db, as, list } = setUp({ now: () => now })

  await as('cli').ping()
  now = new Date(2026, 9, 11, 23, 59)
  await as('cli').ping()
  now = new Date(2026, 9, 12, 0, 0)
  await as('cli').ping()

  expect(db.all(sql`SELECT feature, caller, date, ok, failed FROM usage ORDER BY date`)).toEqual([
    { feature: 'ping', caller: 'cli', date: '2026-10-11', ok: 2, failed: 0 },
    { feature: 'ping', caller: 'cli', date: '2026-10-12', ok: 1, failed: 0 },
  ])
  expect(await list()).toContainEqual({
    feature: 'ping',
    caller: 'cli',
    ok: 3,
    failed: 0,
    lastUsed: '2026-10-12',
  })
})

test('two failures on one day add up in one row', async () => {
  const { db, as } = setUp()

  for (let i = 0; i < 2; i++)
    expect(as('cli').refuse()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await Bun.sleep(0)

  expect(db.all(sql`SELECT feature, caller, ok, failed FROM usage`)).toEqual([
    { feature: 'refuse', caller: 'cli', ok: 0, failed: 2 },
  ])
})

test('the day is the local calendar day of the Backend, not the UTC one', async () => {
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    const { db, as } = setUp({ now: () => new Date('2026-10-11T15:30:00Z') })

    await as('cli').ping()

    expect(db.all(sql`SELECT date FROM usage`)).toEqual([{ date: '2026-10-12' }])
  } finally {
    process.env.TZ = tz
  }
})

test('the result reaches the caller even when writing the Usage throws, with one line on stderr', async () => {
  const { db, as } = setUp()
  db.run(sql`DROP TABLE usage`)
  const stderr = spyOn(console, 'error').mockImplementation(() => {})

  expect(await as('cli').ping()).toBe('pong')
  expect(as('cli').refuse()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await Bun.sleep(0)

  expect(stderr).toHaveBeenCalledTimes(2)
  expect(stderr.mock.calls[0]).toEqual([expect.stringMatching(/^\[usage\] .*ping.*no such table/)])
  stderr.mockRestore()
})

test('list gives never-called Features as 0 calls first, then the rest oldest first, and leaves out Features no longer served', async () => {
  let now = new Date(2026, 9, 10, 12, 0)
  const { as, list } = setUp({ now: () => now })

  await as('webview').ping()
  await as('cli').gone()
  now = new Date(2026, 9, 9, 12, 0)
  await as('cli').ping()
  now = new Date(2026, 9, 11, 12, 0)
  await as('extension').strict({ n: 1 })

  expect(await list()).toEqual([
    { feature: 'refuse', caller: null, ok: 0, failed: 0, lastUsed: null },
    { feature: 'stream', caller: null, ok: 0, failed: 0, lastUsed: null },
    { feature: 'usage.list', caller: null, ok: 0, failed: 0, lastUsed: null },
    { feature: 'ping', caller: 'cli', ok: 1, failed: 0, lastUsed: '2026-10-09' },
    { feature: 'ping', caller: 'webview', ok: 1, failed: 0, lastUsed: '2026-10-10' },
    { feature: 'strict', caller: 'extension', ok: 1, failed: 0, lastUsed: '2026-10-11' },
  ])
})
