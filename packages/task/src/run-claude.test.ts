import { afterEach, expect, mock, setSystemTime, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { startFakePtyd, writeFakeExecutable } from '@monica/workbench/testing'

import { bench, issue, run } from './schema.ts'
import { cleanUp, failure, onCleanup, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

const ref = 'acme/app#12'
const blocker = 'acme/lib#3'

type Fixture = ReturnType<typeof untracked>

function untracked({ blockedBy = [] as string[], origin = true } = {}) {
  const fixture = setup()
  if (origin) fixture.ghq.origin('acme/app', {})
  for (const upstream of blockedBy) fixture.github.issue(upstream, { title: 'Upstream fix' })
  fixture.github.issue(ref, { title: 'Ship it', blockedBy })
  return { ...fixture, cwd: join(fixture.home, 'worktrees/acme/app/issue-12') }
}

async function tracked({ blockedBy = [] as string[], origin = true } = {}) {
  const fixture = untracked({ blockedBy, origin })
  await fixture.client.track({ ref })
  return fixture
}

// claude は最初の prompt まで Agent Session Transcript を書かないので、会話の無かった Agent Session は resume できない。
function transcriptOf({ home }: Fixture, sessionId: string, { written = true } = {}) {
  const path = join(home, 'transcripts', `${sessionId}.jsonl`)
  if (written) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  return path
}

async function endedRun(fixture: Fixture, { cwd = fixture.cwd, conversed = true } = {}) {
  fixture.taskLedger.start()
  const started = await fixture.client.run({ ref })
  const fields = { cwd, transcript_path: transcriptOf(fixture, 's-1', { written: conversed }) }
  await fixture.hook(started.terminalSessionId, 's-1', 'SessionStart', {
    source: 'startup',
    ...fields,
  })
  await fixture.hook(started.terminalSessionId, 's-1', 'SessionEnd', {
    reason: 'prompt_input_exit',
    ...fields,
  })
  return started
}

async function benchTabs({ workbenchClient }: Fixture) {
  const { runspaces } = await workbenchClient.layout.get()
  return runspaces.find((runspace) => runspace.owned)!.tabs
}

// run は Tab を書いて commit したら返り、Create と Write はその後で ptyd に届く。
async function typedInto(fixture: Fixture, terminalSessionId: string) {
  await fixture.ptyd.received((op) => op.op === 'write' && op.session_id === terminalSessionId)
  return fixture.ptyd.sessionRequests().filter((op) => op.session_id === terminalSessionId)
}

// quote が 1 つの引数を保つかは打った文字列の一致では示せないので、本物の shell に解釈させる。
async function argvTypedInto(fixture: Fixture, terminalSessionId: string): Promise<string[]> {
  const write = (await typedInto(fixture, terminalSessionId)).find((op) => op.op === 'write')
  if (write?.op !== 'write') throw new Error('nothing was typed')
  const bin = join(fixture.home, 'argv')
  mkdirSync(bin, { recursive: true })
  writeFakeExecutable(join(bin, 'claude'), `printf '%s\\0' "$@"`)
  const shell = Bun.spawnSync(['/bin/sh', '-c', write.data.replace(/\r$/, '')], {
    env: { PATH: bin },
  })
  return shell.stdout.toString().split('\0').slice(0, -1)
}

function runsOf({ db }: Fixture) {
  return db.select({ agentSessionId: run.agentSessionId }).from(run).orderBy(run.id).all()
}

async function stateOf({ client }: Fixture) {
  return (await client.list({})).tasks.find((t) => t.ref === ref)!.displayState
}

test('run opens a new Tab at the end of the Bench, starts its shell at 24x80 and types claude with /tackle into it', async () => {
  const fixture = await tracked()

  const output = await fixture.client.run({ ref })

  expect(output).toEqual({
    ref,
    title: 'Ship it',
    tracked: false,
    cwd: fixture.cwd,
    mode: 'worktree',
    benchCreated: true,
    warnings: [],
    tabId: expect.any(String),
    terminalSessionId: expect.any(String),
    resumed: null,
  })
  expect(await benchTabs(fixture)).toMatchObject([
    { id: output.tabId, cwd: fixture.cwd, terminalSessionId: output.terminalSessionId },
  ])
  await typedInto(fixture, output.terminalSessionId)
  expect(fixture.ptyd.sessionRequests()).toMatchObject([
    { op: 'create', session_id: output.terminalSessionId, cwd: fixture.cwd, rows: 24, cols: 80 },
    { op: 'write', session_id: output.terminalSessionId, data: "claude '/tackle'\r" },
  ])
})

test("a prompt with ' in it reaches claude as one argument, with nothing in it expanded", async () => {
  const fixture = await tracked()
  const prompt = "fix 'run' so it doesn't expand $HOME or `id`"

  const output = await fixture.client.run({ ref, prompt })

  expect(await argvTypedInto(fixture, output.terminalSessionId)).toEqual([prompt])
})

test.each([
  ['an empty prompt', '', 'empty'],
  ['a prompt of only spaces', '  ', 'empty'],
  ['a prompt with a newline', 'fix\nthe bug', 'control'],
  ['a prompt with a tab', 'fix\tthe bug', 'control'],
  ['a prompt with Ctrl-C', 'fix\u0003', 'control'],
  ['a prompt starting with -', '--help', 'option'],
])('run refuses %s with BAD_REQUEST before it tracks the Issue', async (_, prompt, reason) => {
  const fixture = untracked({ origin: false })

  const error = await failure(fixture.client.run({ ref, prompt }))

  expect(error.code).toBe('BAD_REQUEST')
  expect(error.message).toContain(reason)
  expect((await fixture.client.list({})).tasks).toEqual([])
  expect(await fixture.client.bench.list()).toEqual([])
})

test.each([
  ['owner/repo#n', ref],
  ['the issue URL', 'https://github.com/acme/app/issues/12'],
])(
  'run given %s of an untracked Issue tracks it, prepares its Bench and starts claude in it',
  async (_, asked) => {
    const fixture = untracked()

    const output = await fixture.client.run({ ref: asked })

    expect(output).toMatchObject({
      ref,
      title: 'Ship it',
      tracked: true,
      cwd: fixture.cwd,
      benchCreated: true,
      resumed: null,
    })
    expect((await fixture.client.list({})).tasks).toMatchObject([
      { ref, title: 'Ship it', cwd: fixture.cwd },
    ])
    expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
      data: "claude '/tackle'\r",
    })
  },
)

test("run asked by a repo's old name for an untracked Issue tracks it under the new name and starts claude", async () => {
  const fixture = untracked({ origin: false })
  fixture.github.renameRepo('acme/app', 'acme/renamed')
  fixture.ghq.origin('acme/renamed')

  const output = await fixture.client.run({ ref })

  expect(output).toMatchObject({
    ref: 'acme/renamed#12',
    tracked: true,
    cwd: join(fixture.home, 'worktrees/acme/renamed/issue-12'),
  })
})

test('run refuses an untracked Issue with an open Blocker, and the Issue stays tracked', async () => {
  const fixture = untracked({ blockedBy: [blocker], origin: false })

  const error = await failure(fixture.client.run({ ref }))

  expect(error.code).toBe('BLOCKED')
  expect((await fixture.client.list({})).tasks).toMatchObject([{ ref, blockers: [blocker] }])
  expect(await fixture.client.bench.list()).toEqual([])
})

test('run refuses a ref GitHub does not return with NOT_FOUND, and neither tracks nor copies it', async () => {
  const fixture = untracked({ origin: false })

  const error = await failure(fixture.client.run({ ref: 'acme/app#99' }))

  expect(error.code).toBe('NOT_FOUND')
  expect((await fixture.client.list({})).tasks).toEqual([])
  expect(fixture.db.select().from(issue).all()).toEqual([])
})

test('run returns while ptyd cannot be reached, leaving its Tab starting; once ptyd is back, the shell starts and claude is typed into it', async () => {
  const fixture = await tracked()
  fixture.ptyd.stop()

  const output = await fixture.client.run({ ref })

  expect(await fixture.workbenchClient.terminalSession.list()).toMatchObject([
    { id: output.terminalSessionId, status: 'starting' },
  ])
  const revived = startFakePtyd(fixture.home)
  onCleanup(() => revived.stop())
  await revived.received((op) => op.op === 'write')
  expect(await fixture.settled(output.terminalSessionId)).toMatchObject({ status: 'running' })
  expect(revived.sessionRequests()).toMatchObject([
    { op: 'create', session_id: output.terminalSessionId },
    { op: 'write', session_id: output.terminalSessionId, data: "claude '/tackle'\r" },
  ])
})

test("run resumes the claude of the last Run once it has ended, sending it no /tackle, in a new Tab in that claude's cwd, and makes no new Run", async () => {
  const fixture = await tracked()
  const where = join(fixture.cwd, 'packages/app')
  const first = await endedRun(fixture, { cwd: where })
  mkdirSync(where, { recursive: true })

  const second = await fixture.client.run({ ref })
  await fixture.hook(second.terminalSessionId, 's-1', 'SessionStart', { source: 'resume' })

  expect(second).toMatchObject({
    title: 'Ship it',
    tracked: false,
    benchCreated: false,
    warnings: [],
    resumed: 's-1',
  })
  expect(await benchTabs(fixture)).toMatchObject([
    { id: first.tabId },
    { id: second.tabId, cwd: where },
  ])
  expect(await typedInto(fixture, second.terminalSessionId)).toMatchObject([
    { op: 'create', cwd: where, rows: 24, cols: 80 },
    { op: 'write', data: "claude --resume 's-1'\r" },
  ])
  expect(runsOf(fixture)).toEqual([{ agentSessionId: 's-1' }])
  expect(await stateOf(fixture)).toMatchObject({ state: 'waiting', reason: 'idle' })
})

test('a resume passes the prompt given after the Agent Session', async () => {
  const fixture = await tracked()
  await endedRun(fixture)

  const output = await fixture.client.run({ ref, prompt: 'fix the review comments' })

  expect(output.resumed).toBe('s-1')
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude --resume 's-1' 'fix the review comments'\r",
  })
})

test('a resume neither syncs the Task nor holds it at the Blocker gate', async () => {
  const fixture = await tracked()
  await endedRun(fixture)
  fixture.github.issue(blocker, { title: 'Upstream fix' })
  fixture.github.issue(ref, { title: 'Ship it', blockedBy: [blocker] })
  await fixture.client.sync({ ref })
  fixture.github.logOut()

  const output = await fixture.client.run({ ref })

  expect(output).toMatchObject({ resumed: 's-1', warnings: [] })
})

test("a resume whose claude's cwd is gone starts in the Bench's cwd", async () => {
  const fixture = await tracked()
  await endedRun(fixture, { cwd: '/nonexistent/app' })

  const output = await fixture.client.run({ ref })

  expect(output.resumed).toBe('s-1')
  expect((await benchTabs(fixture)).at(-1)).toMatchObject({ cwd: fixture.cwd })
})

test("run starts a new claude when the Task's Runs all began before its Bench, as after a reopen", async () => {
  const fixture = await tracked()
  await endedRun(fixture)
  fixture.db
    .update(run)
    .set({ startedAt: new Date(0) })
    .run()

  const output = await fixture.client.run({ ref })

  expect(output.resumed).toBeNull()
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('run starts a new claude rather than resume one that left no Agent Session Transcript, as when it exited before any prompt', async () => {
  const fixture = await tracked()
  await endedRun(fixture, { conversed: false })

  const output = await fixture.client.run({ ref })

  expect(output.resumed).toBeNull()
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('run resumes the Run whose claude was active last, even when another began later', async () => {
  const fixture = await tracked()
  fixture.taskLedger.start()
  const first = await fixture.client.run({ ref })
  const second = await fixture.openTab(fixture.db.select().from(bench).get()!.runspaceId)
  const fields = (sessionId: string) => ({ transcript_path: transcriptOf(fixture, sessionId) })
  const t0 = Date.now()
  setSystemTime(t0)
  await fixture.hook(first.terminalSessionId, 's-1', 'SessionStart', fields('s-1'))
  setSystemTime(t0 + 1000)
  await fixture.hook(second, 's-2', 'SessionStart', fields('s-2'))
  await fixture.hook(second, 's-2', 'SessionEnd', fields('s-2'))
  setSystemTime(t0 + 2000)
  await fixture.hook(first.terminalSessionId, 's-1', 'SessionEnd', fields('s-1'))
  setSystemTime()

  const output = await fixture.client.run({ ref })

  expect(output.resumed).toBe('s-1')
})

test('run refuses a Task with a live Run, naming its Agent Session and state, and opens no Tab', async () => {
  const fixture = await tracked()
  fixture.taskLedger.start()
  const { terminalSessionId } = await fixture.client.run({ ref })
  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })

  const error = await failure(fixture.client.run({ ref }))

  expect(error.code).toBe('CONFLICT')
  expect(error.message).toContain('s-1 waiting:idle')
  expect(error.message).toContain('claude')
  expect(await benchTabs(fixture)).toHaveLength(1)
})

test('run refuses a Task whose Issue has an open Blocker, naming it, before it opens the Bench', async () => {
  const fixture = await tracked({ blockedBy: [blocker], origin: false })

  const error = await failure(fixture.client.run({ ref }))

  expect(error.code).toBe('BLOCKED')
  expect(error.data).toEqual({ blockers: [blocker] })
  expect(error.message).toContain(blocker)
  expect(await fixture.client.bench.list()).toEqual([])
  expect(fixture.ptyd.sessionRequests()).toEqual([])
})

test('run --force starts a new Run past the open Blockers', async () => {
  const fixture = await tracked({ blockedBy: [blocker] })

  const output = await fixture.client.run({ ref, force: true })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('run syncs the Task before the gate, so a Blocker closed on GitHub since no longer holds it', async () => {
  const fixture = await tracked({ blockedBy: [blocker] })
  fixture.github.issue(blocker, { title: 'Upstream fix', state: 'closed' })

  const output = await fixture.client.run({ ref })

  expect(output.warnings).toEqual([])
  expect((await fixture.client.list({})).tasks).toMatchObject([{ ref, blockers: [] }])
})

test('run --force still syncs the Task', async () => {
  const fixture = await tracked({ blockedBy: [blocker] })
  fixture.github.issue('acme/lib#4', { title: 'Another fix' })
  fixture.github.issue(ref, { title: 'Ship it', blockedBy: [blocker, 'acme/lib#4'] })

  await fixture.client.run({ ref, force: true })

  expect((await fixture.client.list({})).tasks).toMatchObject([
    { ref, blockers: [blocker, 'acme/lib#4'] },
  ])
})

test('when GitHub cannot be reached, run judges the gate on the copy and warns how old the copy is', async () => {
  const fixture = await tracked()
  fixture.db
    .update(issue)
    .set({ syncedAt: new Date(Date.now() - 12 * 60_000) })
    .run()
  fixture.github.logOut()

  const output = await fixture.client.run({ ref })

  expect(output.warnings).toEqual([
    expect.stringMatching(
      /^could not sync acme\/app#12 from GitHub \(`gh auth token` failed: .+\); using the copy from 12 minutes ago$/,
    ),
  ])
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('when GitHub cannot be reached, an open Blocker in the copy still holds the Task', async () => {
  const fixture = await tracked({ blockedBy: [blocker], origin: false })
  fixture.github.issue(blocker, { title: 'Upstream fix', state: 'closed' })
  fixture.github.logOut()

  const error = await failure(fixture.client.run({ ref }))

  expect(error.code).toBe('BLOCKED')
})

test("run asked by a repo's old name follows the rename its sync finds, keeping the Bench where it is", async () => {
  const fixture = await tracked()
  await fixture.client.run({ ref })
  fixture.github.renameRepo('acme/app', 'acme/renamed')

  const output = await fixture.client.run({ ref })

  expect(output).toMatchObject({ ref: 'acme/renamed#12', cwd: fixture.cwd, resumed: null })
})
