import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { tab } from '@monica/workbench/schema'

import { git } from './fake-ghq.ts'
import { task } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

const ref = 'acme/app#12'

async function tracked() {
  const fixture = setup()
  fixture.ghq.origin('acme/app')
  fixture.github.issue(ref, { title: 'Ship it' })
  await fixture.track(ref)
  const checkout = fixture.ghq.checkout('acme/app')
  return { ...fixture, checkout, cwd: join(checkout, '.claude/worktrees/issue-12') }
}

test('run clones a Repo that has no checkout and opens the Bench where claude --worktree will put the worktree, making none', async () => {
  const { ghq, client, checkout, cwd } = await tracked()

  const output = await client.run({ ref })

  expect(output).toMatchObject({ cwd, mode: 'worktree', benchCreated: true, warnings: [] })
  expect(ghq.gets).toEqual(['acme/app'])
  expect(existsSync(cwd)).toBe(false)
  expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain('issue-12')
  expect(await client.bench.list()).toEqual([
    { runspaceId: expect.any(String), ref, title: 'Ship it' },
  ])
})

test('a run whose Repo ghq cannot clone fails and opens no Bench', async () => {
  const { ghq, client } = await tracked()
  spyOn(ghq.client, 'get').mockRejectedValueOnce(new Error('network is down'))

  const error = await failure(client.run({ ref }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain('network is down')
  expect(await client.bench.list()).toEqual([])
})

test('a second run while the first waits on ghq is refused without a Tab once the first opens its own', async () => {
  const { db, ghq, client } = await tracked()
  const root = await ghq.client.root()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  spyOn(ghq.client, 'root').mockImplementation(() => {
    asked.resolve()
    return answer.promise
  })

  const first = client.run({ ref })
  await asked.promise
  const second = failure(client.run({ ref }))
  answer.resolve(root)

  expect(await first).toMatchObject({ benchCreated: true })
  expect(await second).toMatchObject({
    code: 'CONFLICT',
    message: `${ref} has a Run being started; to add an agent alongside, open a Tab in its Bench and run claude there`,
  })
  expect(db.select().from(tab).all()).toHaveLength(1)
})

test("run --in-place opens the Bench on the Repo's checkout, cloning it", async () => {
  const { ghq, client, checkout, exit } = await tracked()

  const output = await client.run({ ref, inPlace: true })
  await exit(output.terminalSessionId)

  expect(output).toMatchObject({
    ref,
    cwd: checkout,
    mode: 'in_place',
    benchCreated: true,
    warnings: [],
  })
  expect(ghq.gets).toEqual(['acme/app'])
  expect(git(checkout, 'status', '--porcelain')).toBe('')
  expect(await client.run({ ref })).toMatchObject({ cwd: checkout, benchCreated: false })
})

test('task.changes signals the Task when run opens its Bench', async () => {
  const { client, taskLedger } = await tracked()
  const signalled: string[] = []
  taskLedger.events.subscribe('change', (change) => {
    if (change.type === 'task') signalled.push(change.ref)
  })

  await client.run({ ref })

  expect(signalled).toContain(ref)
})

test('run --in-place refuses a Bench that is a worktree', async () => {
  const { client } = await tracked()
  await client.run({ ref })

  const error = await failure(client.run({ ref, inPlace: true }))

  expect(error.code).toBe('BAD_REQUEST')
})

test('run refuses a closed Task before it syncs, pointing to reopen rather than tracking it again', async () => {
  const { db, client, github } = await tracked()
  db.update(task).set({ closedAt: new Date() }).run()
  const sent = github.requests.length

  const error = await failure(client.run({ ref }))

  expect(error.code).toBe('BAD_REQUEST')
  expect(error.message).toBe(`${ref} is closed, so run \`monica task reopen ${ref}\``)
  expect(github.requests).toHaveLength(sent)
  expect(await client.bench.list()).toEqual([])
})
