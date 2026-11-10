import { Database } from 'bun:sqlite'
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../migrations/index.ts'
import { createStudyLedger, router } from './server.ts'

const homes: string[] = []
afterEach(() => {
  setSystemTime()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

// 紐付けは claude を起こさないので、query は渡さない。
function setup() {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const home = mkdtempSync(join(tmpdir(), 'monica-study-repo-'))
  homes.push(home)
  const studyLedger = createStudyLedger({ db, home, openInEditor: async () => {} })
  return createRouterClient(router, { context: { db, studyLedger } })
}

test('a linked Repo shows in get, list and the Studies of the Repo, and linking it again in another case keeps the first spelling', async () => {
  const client = setup()
  const { id } = await client.start({})

  await client.repo.link({ id, repo: 'Acme/Alpha' })
  await client.repo.link({ id, repo: 'acme/alpha' })
  await client.repo.link({ id, repo: 'acme/beta' })

  expect((await client.get({ id })).repos).toEqual(['Acme/Alpha', 'acme/beta'])
  expect((await client.list({})).studies[0]!.repos).toEqual(['Acme/Alpha', 'acme/beta'])
  expect(await client.repo.studies({ repo: 'acme/alpha' })).toEqual({
    studies: [{ id, missionLine: null, firstMessage: null, lastActivityAt: expect.any(Date) }],
  })
})

test('unlink removes a Repo linked in another case, and unlinking a Repo not linked does not fail', async () => {
  const client = setup()
  const { id } = await client.start({})
  await client.repo.link({ id, repo: 'acme/alpha' })
  await client.repo.link({ id, repo: 'acme/beta' })

  await client.repo.unlink({ id, repo: 'ACME/ALPHA' })
  await client.repo.unlink({ id, repo: 'acme/gamma' })

  expect((await client.get({ id })).repos).toEqual(['acme/beta'])
  expect(await client.repo.studies({ repo: 'acme/alpha' })).toEqual({ studies: [] })
})

test('the Studies of a Repo are found in any case, the most recently active first, and a Repo with no Study has none', async () => {
  const client = setup()
  setSystemTime(new Date('2026-11-11T00:00:00Z'))
  const older = await client.start({})
  setSystemTime(new Date('2026-11-11T01:00:00Z'))
  const newer = await client.start({})
  const unlinked = await client.start({})
  await client.repo.link({ id: older.id, repo: 'acme/alpha' })
  await client.repo.link({ id: newer.id, repo: 'Acme/Alpha' })
  await client.repo.link({ id: unlinked.id, repo: 'acme/beta' })

  const { studies } = await client.repo.studies({ repo: 'ACME/alpha' })

  expect(studies.map((s) => s.id)).toEqual([newer.id, older.id])
  expect(await client.repo.studies({ repo: 'acme/gamma' })).toEqual({ studies: [] })
})

test('linking to a Study that does not exist is NOT_FOUND', async () => {
  const client = setup()

  await expect(
    client.repo.link({ id: 'study-0190a000-0000-7000-8000-000000000001', repo: 'acme/alpha' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('a Repo that is not owner/repo is refused with BAD_REQUEST', async () => {
  const client = setup()
  const { id } = await client.start({})

  for (const repo of ['owner', 'owner/repo/x', 'github.com/owner/repo', 'owner/re po']) {
    await expect(client.repo.link({ id, repo })).rejects.toMatchObject({ status: 400 })
    await expect(client.repo.unlink({ id, repo })).rejects.toMatchObject({ status: 400 })
    await expect(client.repo.studies({ repo })).rejects.toMatchObject({ status: 400 })
  }
  expect((await client.get({ id })).repos).toEqual([])
})
