import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRouterClient, ORPCError } from '@orpc/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { migrations } from '../migrations/index.ts'
import { createStudyLedger, router } from './server.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'monica-study-artifact-'))
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrations.folder, migrationsTable: migrations.table })
  const opened: string[] = []
  const studyLedger = createStudyLedger({
    db,
    home,
    openInEditor: async (path) => {
      opened.push(path)
    },
  })
  const client = createRouterClient(router, { context: { db, studyLedger } })
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const { id } = await client.start({})
  const dir = join(home, 'studies', id)
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return { home, client, id, dir, write, opened }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ORPCError) return error.code
    throw error
  }
  throw new Error('it did not refuse')
}

test('artifact.list returns the artifacts that exist in order, with Learning Record titles from the heading or the file name', async () => {
  const { client, id, write } = await setup()
  write('log.md', '# log\n')
  write('MISSION.md', '# Understand ky\n')
  write('learning-records/0002-no-heading.md', 'just text\n')
  write('learning-records/0001-retry.md', '\n# Retry waits for Retry-After\n\nbody\n')
  write('learning-records/notes.txt', 'not markdown')
  write('other.md', 'not an artifact')

  const { artifacts } = await client.artifact.list({ id })

  expect(artifacts).toEqual([
    { path: 'MISSION.md', title: null },
    { path: 'log.md', title: null },
    { path: 'learning-records/0001-retry.md', title: 'Retry waits for Retry-After' },
    { path: 'learning-records/0002-no-heading.md', title: 'no-heading' },
  ])
})

test('artifact.list of a Study with no artifacts is empty, and of no Study is NOT_FOUND', async () => {
  const { client, id } = await setup()

  expect((await client.artifact.list({ id })).artifacts).toEqual([])
  expect(await codeOf(client.artifact.list({ id: 'study-0000' }))).toBe('NOT_FOUND')
})

test('artifact.list leaves out a learning-records that is a symlink, even to a dir inside the Study', async () => {
  const { home, client, id, dir, write } = await setup()
  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, '0001-private.md'), '# Private\n')
  write('records/0001-inside.md', '# Inside\n')

  symlinkSync(outside, join(dir, 'learning-records'))
  const toOutside = (await client.artifact.list({ id })).artifacts
  rmSync(join(dir, 'learning-records'))
  symlinkSync(join(dir, 'records'), join(dir, 'learning-records'))
  const toInside = (await client.artifact.list({ id })).artifacts

  expect([toOutside, toInside]).toEqual([[], []])
})

test('artifact.read returns the content, and reads a symlink that points inside the Study dir', async () => {
  const { client, id, dir, write } = await setup()
  write('GLOSSARY.md', '# Glossary\n')
  symlinkSync(join(dir, 'GLOSSARY.md'), join(dir, 'alias.md'))

  expect(await client.artifact.read({ id, path: 'GLOSSARY.md' })).toEqual({
    path: 'GLOSSARY.md',
    content: '# Glossary\n',
  })
  expect((await client.artifact.read({ id, path: 'alias.md' })).content).toBe('# Glossary\n')
})

test('artifact.read refuses paths outside the Study dir, dirs, non-regular files and files over 1 MiB with FORBIDDEN', async () => {
  const { home, client, id, dir, write } = await setup()
  writeFileSync(join(home, 'secret.md'), 'secret')
  mkdirSync(join(home, 'outside'))
  writeFileSync(join(home, 'outside', 'x.md'), 'secret')
  write('learning-records/0001-x.md', 'x')
  symlinkSync(join(home, 'secret.md'), join(dir, 'to-file.md'))
  symlinkSync(join(home, 'outside'), join(dir, 'to-dir'))
  Bun.spawnSync(['mkfifo', join(dir, 'fifo.md')])
  write('big.md', 'x'.repeat(1024 * 1024 + 1))

  const refused = [
    '../secret.md',
    'learning-records/../../secret.md',
    join(home, 'secret.md'),
    'to-file.md',
    'to-dir/x.md',
    'learning-records',
    'fifo.md',
    'big.md',
  ]
  const codes = await Promise.all(refused.map((path) => codeOf(client.artifact.read({ id, path }))))

  expect(codes).toEqual(refused.map(() => 'FORBIDDEN'))
})

test('artifact.read of a missing file or a missing Study is NOT_FOUND', async () => {
  const { client, id } = await setup()

  expect(await codeOf(client.artifact.read({ id, path: 'MISSION.md' }))).toBe('NOT_FOUND')
  expect(await codeOf(client.artifact.read({ id: 'study-0000', path: 'MISSION.md' }))).toBe(
    'NOT_FOUND',
  )
})

test('artifact.open passes the realpath to openInEditor, and does not call it for what read refuses', async () => {
  const { home, client, id, dir, write, opened } = await setup()
  write('MISSION.md', '# m\n')
  symlinkSync(join(dir, 'MISSION.md'), join(dir, 'alias.md'))
  writeFileSync(join(home, 'secret.md'), 'secret')

  await client.artifact.open({ id, path: 'alias.md' })
  const codes = [
    await codeOf(client.artifact.open({ id, path: '../secret.md' })),
    await codeOf(client.artifact.open({ id, path: '.' })),
    await codeOf(client.artifact.open({ id, path: 'nothing.md' })),
  ]

  expect(opened).toEqual([realpathSync(join(dir, 'MISSION.md'))])
  expect(codes).toEqual(['FORBIDDEN', 'FORBIDDEN', 'NOT_FOUND'])
})
