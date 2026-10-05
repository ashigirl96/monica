import { afterEach, expect, mock, test } from 'bun:test'

import { nameAgentSession } from './server.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'

async function withBench({ start }: { start: boolean }) {
  const books = setup()
  books.ghq.origin('acme/app', {})
  if (start) books.task.start()
  return { ...books, benchRunspace: await books.openBench(ref) }
}

test("current names the Task of the Run of the calling Tab's claude, even outside the Bench", async () => {
  const books = await withBench({ start: true })
  const inBench = await books.openTab(books.benchRunspace)
  const outside = await books.openTabOutsideBench()
  await books.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await books.hook(outside, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(await books.client.current({ terminalSessionId: outside })).toEqual({
    ref,
    title: 'Ship it',
    displayState: expect.objectContaining({ state: 'running' }),
    agentSessionId: 's-1',
    source: 'run',
  })
})

test('current names the Task of the Bench the calling Tab is in when its claude is no Run', async () => {
  const books = await withBench({ start: true })
  const inBench = await books.openTab(books.benchRunspace)

  expect(await books.client.current({ terminalSessionId: inBench })).toEqual({
    ref,
    title: 'Ship it',
    displayState: { state: 'ended' },
    agentSessionId: null,
    source: 'bench',
  })
})

test('current fails for a Tab with no Run outside a Bench, and outside a Tab', async () => {
  const books = await withBench({ start: true })
  const outside = await books.openTabOutsideBench()
  await books.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  expect((await failure(books.client.current({ terminalSessionId: outside }))).code).toBe(
    'NOT_FOUND',
  )
  expect((await failure(books.client.current({}))).code).toBe('BAD_REQUEST')
})

test('nameAgentSession names the Task of the Run, even after its claude moves out of the Bench', async () => {
  const books = await withBench({ start: true })
  const inBench = await books.openTab(books.benchRunspace)
  const outside = await books.openTabOutsideBench()
  await books.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await books.hook(outside, 's-1', 'UserPromptSubmit', { prompt: 'go on' })

  expect(nameAgentSession(books.db, 's-1')).toBe('app#12 Ship it')
})

test('nameAgentSession names the Task of the Bench for a claude in it that is no Run yet', async () => {
  const books = await withBench({ start: false })
  const inBench = await books.openTab(books.benchRunspace)
  await books.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })

  expect(nameAgentSession(books.db, 's-1')).toBe('app#12 Ship it')
})

test('nameAgentSession has no name for a claude that has nothing to do with a Task', async () => {
  const books = await withBench({ start: true })
  const outside = await books.openTabOutsideBench()
  await books.hook(outside, 's-1', 'SessionStart', { source: 'startup' })

  expect(nameAgentSession(books.db, 's-1')).toBeNull()
})

test('the notification for a Run waiting on the user is titled with its Task', async () => {
  const books = await withBench({ start: true })
  const inBench = await books.openTab(books.benchRunspace)
  await books.hook(inBench, 's-1', 'SessionStart', { source: 'startup' })
  await books.hook(inBench, 's-1', 'UserPromptSubmit', { prompt: 'ship it' })

  await books.hook(inBench, 's-1', 'PermissionRequest', {
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
  })

  expect(books.notifications).toEqual([{ title: 'app#12 Ship it', body: '許可: Bash' }])
})
