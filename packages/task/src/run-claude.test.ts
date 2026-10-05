import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { bench, issue, run } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'
const blocker = 'acme/lib#3'

type Books = Awaited<ReturnType<typeof tracked>>

async function tracked({ blockedBy = [] as string[] } = {}) {
  const books = setup()
  books.ghq.origin('acme/app', {})
  for (const upstream of blockedBy) books.github.issue(upstream, { title: 'Upstream fix' })
  books.github.issue(ref, { title: 'Ship it', blockedBy })
  await books.client.track({ ref })
  return { ...books, cwd: join(books.home, 'worktrees/acme/app/issue-12') }
}

// claude は最初の prompt まで transcript を書かないので、会話の無かった Agent Session は resume できない。
function transcriptOf({ home }: Books, sessionId: string, { written = true } = {}) {
  const path = join(home, 'transcripts', `${sessionId}.jsonl`)
  if (written) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  return path
}

async function endedRun(books: Books, { cwd = books.cwd, conversed = true } = {}) {
  books.task.start()
  const started = await books.client.run({ ref })
  const fields = { cwd, transcript_path: transcriptOf(books, 's-1', { written: conversed }) }
  await books.hook(started.terminalSessionId, 's-1', 'SessionStart', {
    source: 'startup',
    ...fields,
  })
  await books.hook(started.terminalSessionId, 's-1', 'SessionEnd', {
    reason: 'prompt_input_exit',
    ...fields,
  })
  return started
}

async function benchTabs({ workbenchClient }: Books) {
  const { runspaces } = await workbenchClient.layout.get()
  return runspaces.find((runspace) => runspace.owned)!.tabs
}

// Write の data は base64 なので、打った文字列に戻して比べる。
function sent({ ptyd }: Books) {
  return ptyd
    .receivedAll((op) => 'session_id' in op)
    .map((op) =>
      op.op === 'write' ? { ...op, data: Buffer.from(op.data, 'base64').toString() } : op,
    )
}

function sentTo(books: Books, terminalSessionId: string) {
  return sent(books).filter((op) => op.session_id === terminalSessionId)
}

function runsOf({ db }: Books) {
  return db.select({ agentSessionId: run.agentSessionId }).from(run).orderBy(run.id).all()
}

async function stateOf({ client }: Books) {
  return (await client.list({})).tasks.find((t) => t.ref === ref)!.displayState
}

test('run opens a new Tab at the end of the Bench, starts its shell at 24x80 and types claude into it', async () => {
  const books = await tracked()

  const output = await books.client.run({ ref })

  expect(output).toEqual({
    ref,
    cwd: books.cwd,
    mode: 'worktree',
    benchCreated: true,
    warnings: [],
    tabId: expect.any(String),
    terminalSessionId: expect.any(String),
    resumed: null,
  })
  expect(await benchTabs(books)).toMatchObject([
    { id: output.tabId, cwd: books.cwd, terminalSessionId: output.terminalSessionId },
  ])
  expect(sent(books)).toMatchObject([
    { op: 'create', session_id: output.terminalSessionId, cwd: books.cwd, rows: 24, cols: 80 },
    { op: 'write', session_id: output.terminalSessionId, data: 'claude\r' },
  ])
})

test('the claude run started becomes a Run of the Task, waiting idle', async () => {
  const books = await tracked()
  books.task.start()
  const { terminalSessionId } = await books.client.run({ ref })

  await books.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  expect(runsOf(books)).toEqual([{ agentSessionId: 's-1' }])
  expect(await stateOf(books)).toMatchObject({ state: 'waiting', reason: 'idle' })
})

test("run resumes the claude of the last Run once it has ended, in a new Tab in that claude's cwd, and makes no new Run", async () => {
  const books = await tracked()
  const where = join(books.cwd, 'packages/app')
  const first = await endedRun(books, { cwd: where })
  mkdirSync(where, { recursive: true })

  const second = await books.client.run({ ref })
  await books.hook(second.terminalSessionId, 's-1', 'SessionStart', { source: 'resume' })

  expect(second).toMatchObject({ benchCreated: false, warnings: [], resumed: 's-1' })
  expect(await benchTabs(books)).toMatchObject([
    { id: first.tabId },
    { id: second.tabId, cwd: where },
  ])
  expect(sentTo(books, second.terminalSessionId)).toMatchObject([
    { op: 'create', cwd: where, rows: 24, cols: 80 },
    { op: 'write', data: "claude --resume 's-1'\r" },
  ])
  expect(runsOf(books)).toEqual([{ agentSessionId: 's-1' }])
  expect(await stateOf(books)).toMatchObject({ state: 'waiting', reason: 'idle' })
})

test('a resume neither syncs the Task nor holds it at the Blocker gate', async () => {
  const books = await tracked()
  await endedRun(books)
  books.github.issue(blocker, { title: 'Upstream fix' })
  books.github.issue(ref, { title: 'Ship it', blockedBy: [blocker] })
  await books.client.sync({ ref })
  books.github.logOut()

  const output = await books.client.run({ ref })

  expect(output).toMatchObject({ resumed: 's-1', warnings: [] })
})

test("a resume whose claude's cwd is gone starts in the Bench's cwd", async () => {
  const books = await tracked()
  await endedRun(books, { cwd: '/nonexistent/app' })

  const output = await books.client.run({ ref })

  expect(output.resumed).toBe('s-1')
  expect((await benchTabs(books)).at(-1)).toMatchObject({ cwd: books.cwd })
})

test("run starts a new claude when the Task's Runs all began before its Bench, as after a reopen", async () => {
  const books = await tracked()
  await endedRun(books)
  books.db
    .update(run)
    .set({ startedAt: new Date(0) })
    .run()

  const output = await books.client.run({ ref })

  expect(output.resumed).toBeNull()
  expect(sentTo(books, output.terminalSessionId).at(-1)).toMatchObject({ data: 'claude\r' })
})

test('run starts a new claude rather than resume one that left no transcript, as when it exited before any prompt', async () => {
  const books = await tracked()
  await endedRun(books, { conversed: false })

  const output = await books.client.run({ ref })

  expect(output.resumed).toBeNull()
  expect(sentTo(books, output.terminalSessionId).at(-1)).toMatchObject({ data: 'claude\r' })
})

test('run resumes the Run whose claude was active last, even when another began later', async () => {
  const books = await tracked()
  books.task.start()
  const first = await books.client.run({ ref })
  const second = await books.openTab(books.db.select().from(bench).get()!.runspaceId)
  const fields = (sessionId: string) => ({ transcript_path: transcriptOf(books, sessionId) })
  await books.hook(first.terminalSessionId, 's-1', 'SessionStart', fields('s-1'))
  await Bun.sleep(5)
  await books.hook(second, 's-2', 'SessionStart', fields('s-2'))
  await books.hook(second, 's-2', 'SessionEnd', fields('s-2'))
  await Bun.sleep(5)
  await books.hook(first.terminalSessionId, 's-1', 'SessionEnd', fields('s-1'))

  const output = await books.client.run({ ref })

  expect(output.resumed).toBe('s-1')
})

test('run refuses a Task with a live Run, naming its Agent Session and state, and opens no Tab', async () => {
  const books = await tracked()
  books.task.start()
  const { terminalSessionId } = await books.client.run({ ref })
  await books.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  const error = await failure(books.client.run({ ref }))

  expect(error.code).toBe('CONFLICT')
  expect(error.message).toContain('s-1 waiting:idle')
  expect(error.message).toContain('claude')
  expect(await benchTabs(books)).toHaveLength(1)
})

test('run refuses a Task whose Issue has an open Blocker, naming it, before it opens the Bench', async () => {
  const books = await tracked({ blockedBy: [blocker] })

  const error = await failure(books.client.run({ ref }))

  expect(error.code).toBe('BLOCKED')
  expect(error.data).toEqual({ blockers: [blocker] })
  expect(error.message).toContain(blocker)
  expect(await books.client.bench.list()).toEqual([])
  expect(sent(books)).toEqual([])
})

test('run --force starts a new Run past the open Blockers', async () => {
  const books = await tracked({ blockedBy: [blocker] })

  const output = await books.client.run({ ref, force: true })

  expect(sentTo(books, output.terminalSessionId).at(-1)).toMatchObject({ data: 'claude\r' })
})

test('run syncs the Task before the gate, so a Blocker closed on GitHub since no longer holds it', async () => {
  const books = await tracked({ blockedBy: [blocker] })
  books.github.issue(blocker, { title: 'Upstream fix', state: 'closed' })

  const output = await books.client.run({ ref })

  expect(output.warnings).toEqual([])
  expect((await books.client.list({})).tasks).toMatchObject([{ ref, blockers: [] }])
})

test('run --force still syncs the Task', async () => {
  const books = await tracked({ blockedBy: [blocker] })
  books.github.issue('acme/lib#4', { title: 'Another fix' })
  books.github.issue(ref, { title: 'Ship it', blockedBy: [blocker, 'acme/lib#4'] })

  await books.client.run({ ref, force: true })

  expect((await books.client.list({})).tasks).toMatchObject([
    { ref, blockers: [blocker, 'acme/lib#4'] },
  ])
})

test('when GitHub cannot be reached, run judges the gate on the copy and warns how old the copy is', async () => {
  const books = await tracked()
  books.db
    .update(issue)
    .set({ syncedAt: new Date(Date.now() - 12 * 60_000) })
    .run()
  books.github.logOut()

  const output = await books.client.run({ ref })

  expect(output.warnings).toEqual([
    expect.stringMatching(
      /^could not sync acme\/app#12 from GitHub \(`gh auth token` failed: .+\); using the copy from 12 minutes ago$/,
    ),
  ])
  expect(sentTo(books, output.terminalSessionId).at(-1)).toMatchObject({ data: 'claude\r' })
})

test('when GitHub cannot be reached, an open Blocker in the copy still holds the Task', async () => {
  const books = await tracked({ blockedBy: [blocker] })
  books.github.issue(blocker, { title: 'Upstream fix', state: 'closed' })
  books.github.logOut()

  const error = await failure(books.client.run({ ref }))

  expect(error.code).toBe('BLOCKED')
})

test("run asked by a repo's old name follows the rename its sync finds, keeping the Bench where it is", async () => {
  const books = await tracked()
  await books.client.run({ ref })
  books.github.renameRepo('acme/app', 'acme/renamed')

  const output = await books.client.run({ ref })

  expect(output).toMatchObject({ ref: 'acme/renamed#12', cwd: books.cwd, resumed: null })
})
