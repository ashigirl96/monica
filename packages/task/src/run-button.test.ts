import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { tab } from '@monica/workbench/schema'

import { issue, task } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'

type Fixture = ReturnType<typeof setup>

// press は worktree の Bench を開くので、新しい Bench まで進むテストだけが origin を要る。
function withOrigin() {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  return fixture
}

test('an untracked ready-for-agent Issue gets a tackle button for a new Run', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('an Issue with an open Blocker gets no button, and one whose Blockers are all closed does', async () => {
  const { github, client } = setup()
  github.issue('acme/lib#3', { title: 'Upstream fix' })
  github.issue('acme/lib#4', { title: 'Done upstream', state: 'closed' })
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'], blockedBy: ['acme/lib#3'] })
  github.issue('acme/app#13', {
    title: 'Ship that',
    labels: ['ready-for-agent'],
    blockedBy: ['acme/lib#4'],
  })

  expect(await client.runButtons({ refs: [ref, 'acme/app#13'] })).toEqual({
    buttons: [
      { ref, button: null, reason: expect.stringContaining('blocked by acme/lib#3') },
      { ref: 'acme/app#13', button: { kind: 'tackle', run: 'new' }, reason: null },
    ],
  })
})

test.each([['ready-for-human'], ['needs-info'], ['wontfix']])(
  'a %s Issue gets no button',
  async (label) => {
    const { github, client } = setup()
    github.issue(ref, { title: 'Ship it', labels: [label, 'bug'] })

    expect(await client.runButtons({ refs: [ref] })).toEqual({
      buttons: [{ ref, button: null, reason: `${ref} has no label that picks a prompt` }],
    })
  },
)

test('a wayfinder Issue with no parent map gets no button', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ask it', labels: ['wayfinder:grilling'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: `${ref} is a wayfinder Issue with no map above it` }],
  })
})

test('a wayfinder Issue under a parent that is not a map gets no button', async () => {
  const { github, client } = setup()
  github.issue('acme/app#7', { title: 'Plain', labels: ['enhancement'] })
  github.issue(ref, { title: 'Ask it', labels: ['wayfinder:task'], parent: 'acme/app#7' })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: expect.stringContaining('acme/app#7') }],
  })
})

test.each([[[]], [['bug', 'enhancement']]])(
  'an Issue with no state label, labelled %j, gets a triage button',
  async (labels) => {
    const { github, client } = setup()
    github.issue(ref, { title: 'Ship it', labels })

    expect(await client.runButtons({ refs: [ref] })).toEqual({
      buttons: [{ ref, button: { kind: 'triage', run: 'new' }, reason: null }],
    })
  },
)

test('a closed Issue gets no button', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: `${ref} is a closed Issue` }],
  })
})

test('telling the buttons tracks no Issue', async () => {
  const { github, client, db } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  await client.runButtons({ refs: [ref] })

  expect(db.select().from(task).all()).toEqual([])
})

test('a closed Task gets a reopen button, pressing a Run shown before gives the reopen button back, and pressing Reopen gives its Run button back', async () => {
  const { github, client, track } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await track(ref)
  await client.close({ ref })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { run: 'reopen' }, reason: null }],
  })
  expect(await client.press({ ref, run: 'new' })).toEqual({
    ref,
    button: { run: 'reopen' },
    reason: null,
  })
  expect((await client.list({ closed: true })).tasks.map((t) => t.ref)).toEqual([ref])

  expect(await client.press({ ref, run: 'reopen' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'new' },
    reason: null,
  })
  expect((await client.list({})).tasks.map((t) => t.ref)).toEqual([ref])
})

test('pressing Reopen reads the Issue anew and leaves a Task whose Issue was closed since closed, giving the row with no button', async () => {
  const { github, client, track } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await track(ref)
  await client.close({ ref })
  github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  expect(await client.press({ ref, run: 'reopen' })).toEqual({
    ref,
    button: null,
    reason: `${ref} is a closed Issue`,
  })
  expect((await client.list({ closed: true })).tasks.map((t) => t.ref)).toEqual([ref])
})

test('a closed Task whose repo was renamed before any sync gets its reopen button by the new name, and pressing it reopens the Task', async () => {
  const { github, client, track } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await track(ref)
  await client.close({ ref })
  github.renameRepo('acme/app', 'acme/renamed')
  const renamed = 'acme/renamed#12'

  expect(await client.runButtons({ refs: [renamed] })).toEqual({
    buttons: [{ ref: renamed, button: { run: 'reopen' }, reason: null }],
  })
  expect(await client.press({ ref: renamed, run: 'reopen' })).toEqual({
    ref: renamed,
    button: { kind: 'tackle', run: 'new' },
    reason: null,
  })
  expect(await client.runButtons({ refs: [renamed] })).toEqual({
    buttons: [{ ref: renamed, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('pressing Reopen leaves a Task whose Issue is closed between the read and the sync of reopen closed, giving the reopen button back', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.track(ref)
  await fixture.client.close({ ref })

  const releaseRead = fixture.github.hold()
  const before = fixture.github.requests.length
  const reopening = fixture.client.press({ ref, run: 'reopen' })
  await fixture.github.received(before + 1)
  releaseRead()
  const releaseSync = fixture.github.hold()
  await fixture.github.received(before + 2)
  fixture.github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })
  releaseSync()

  expect(await reopening).toEqual({ ref, button: { run: 'reopen' }, reason: null })
  expect((await fixture.client.list({ closed: true })).tasks.map((t) => t.ref)).toEqual([ref])
})

test('pressing Reopen of a Task reopened since does nothing and gives its Run button', async () => {
  const fixture = withOrigin()
  const { github, client, db, track } = fixture
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await track(ref)
  await client.close({ ref })
  await client.reopen({ ref })
  const before = db.select().from(task).all()

  expect(await client.press({ ref, run: 'reopen' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'new' },
    reason: null,
  })
  expect(db.select().from(task).all()).toEqual(before)
  expect(await client.bench.list()).toEqual([])
  expect(tabCount(fixture)).toBe(0)
})

test('a closed Task of a closed Issue gets no reopen button', async () => {
  const { github, client, track } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await track(ref)
  await client.close({ ref })
  github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: `${ref} is a closed Issue` }],
  })
})

test('an Issue GitHub does not return, one of a failing repo and a malformed ref get no button, and the rest still do', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  github.issue('acme/lib#3', { title: 'Upstream fix', labels: ['ready-for-agent'] })
  github.fail('acme/lib')

  expect(
    await client.runButtons({ refs: [ref, 'acme/app#99', 'acme/lib#3', 'not a ref'] }),
  ).toEqual({
    buttons: [
      { ref, button: { kind: 'tackle', run: 'new' }, reason: null },
      { ref: 'acme/app#99', button: null, reason: null },
      { ref: 'acme/lib#3', button: null, reason: null },
      { ref: 'not a ref', button: null, reason: null },
    ],
  })
})

const typesClaude = (data: string) => data.startsWith('claude ')

// press は Terminal Session を返さないので、ptyd に届いた Write から打った claude を読む。Write は commit の後で届く。
async function typedClaude(fixture: Fixture, count = 1) {
  await fixture.ptyd.receivedAtLeast(
    count,
    (op) => op.op === 'write' && typesClaude(Buffer.from(op.data, 'base64').toString()),
  )
  return fixture.ptyd
    .sessionRequests()
    .flatMap((op) => (op.op === 'write' && typesClaude(op.data) ? [op.data] : []))
}

const tabCount = ({ db }: Pick<Fixture, 'db'>) => db.select().from(tab).all().length

test('pressing a tackle Run tracks the Issue, types claude with /tackle into a Tab of its Bench and gives the running button', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  expect(await fixture.client.press({ ref, run: 'new' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'running' },
    reason: null,
  })
  expect(await typedClaude(fixture)).toEqual(["claude '/tackle'\r"])
  expect((await fixture.client.list({})).tasks.map((t) => t.ref)).toEqual([ref])
  expect(await fixture.client.bench.list()).toHaveLength(1)
})

test('pressing a Run whose Bench cannot be prepared fails, opening no Tab', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  const error = await failure(fixture.client.press({ ref, run: 'new' }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain('could not prepare the Bench')
  expect(tabCount(fixture)).toBe(0)
})

test('pressing a triage Run types claude with /triage and the Issue number', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'triage', run: 'new' }, reason: null }],
  })
  await fixture.client.press({ ref, run: 'new' })

  expect(await typedClaude(fixture)).toEqual(["claude '/triage #12'\r"])
})

test('pressing the Run of a wayfinder map types claude with /wayfinder and the map, even when it has open sub-issues', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Map it', labels: ['wayfinder:map'] })
  fixture.github.issue('acme/app#13', {
    title: 'Ask it',
    labels: ['wayfinder:grilling'],
    parent: ref,
  })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'wayfinder', run: 'new' }, reason: null }],
  })
  await fixture.client.press({ ref, run: 'new' })

  expect(await typedClaude(fixture)).toEqual(["claude '/wayfinder 12'\r"])
})

test('pressing the Run of a ready-for-agent Issue with an open sub-issue types claude with /implement-spec and the Issue number', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue('acme/app#13', { title: 'Done part', state: 'closed', parent: ref })
  fixture.github.issue('acme/app#14', { title: 'Next part', parent: ref })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'implement-spec', run: 'new' }, reason: null }],
  })
  await fixture.client.press({ ref, run: 'new' })

  expect(await typedClaude(fixture)).toEqual(["claude '/implement-spec #12'\r"])
})

test('a ready-for-agent Issue whose sub-issues are all closed gets no button', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  github.issue('acme/app#13', { title: 'Done part', state: 'closed', parent: ref })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: `${ref} is a spec whose sub-issues are all closed` }],
  })
})

test.each([
  ['wayfinder:grilling'],
  ['wayfinder:prototype'],
  ['wayfinder:research'],
  ['wayfinder:task'],
])('a %s Issue under a map gets a wayfinder button', async (label) => {
  const { github, client } = setup()
  github.issue('acme/app#7', { title: 'Map it', labels: ['wayfinder:map'] })
  github.issue(ref, { title: 'Ask it', labels: [label], parent: 'acme/app#7' })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'wayfinder', run: 'new' }, reason: null }],
  })
})

test('pressing the Run of a wayfinder Issue under a map types claude with /wayfinder, its map and itself into a Bench of its own Task', async () => {
  const fixture = withOrigin()
  fixture.github.issue('acme/app#7', { title: 'Map it', labels: ['wayfinder:map'] })
  fixture.github.issue(ref, {
    title: 'Ask it',
    labels: ['wayfinder:grilling'],
    parent: 'acme/app#7',
  })

  await fixture.client.press({ ref, run: 'new' })

  expect(await typedClaude(fixture)).toEqual(["claude '/wayfinder 7 12'\r"])
  expect((await fixture.client.list({})).tasks.map((t) => t.ref)).toEqual([ref])
})

test('pressing a Run reads the labels anew and gives the row of an Issue that has lost its button, opening no Bench', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.runButtons({ refs: [ref] })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-human'] })

  expect(await fixture.client.press({ ref, run: 'new' })).toEqual({
    ref,
    button: null,
    reason: `${ref} has no label that picks a prompt`,
  })
  expect(await fixture.client.bench.list()).toEqual([])
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('pressing a Run of an Issue with an open Blocker gives the row naming it, opening no Bench', async () => {
  const fixture = setup()
  fixture.github.issue('acme/lib#3', { title: 'Upstream fix' })
  fixture.github.issue(ref, {
    title: 'Ship it',
    labels: ['ready-for-agent'],
    blockedBy: ['acme/lib#3'],
  })

  expect(await fixture.client.press({ ref, run: 'new' })).toEqual({
    ref,
    button: null,
    reason: `${ref} is blocked by acme/lib#3`,
  })
  expect(await fixture.client.bench.list()).toEqual([])
})

// 呼び手が Task を先に track しておき、2 本目の request を新しい Run の sync にする。
async function pressHeldUntilSync(fixture: Fixture, change: () => void) {
  const releaseRead = fixture.github.hold()
  const before = fixture.github.requests.length
  const pressing = fixture.client.press({ ref, run: 'new' })
  await fixture.github.received(before + 1)
  releaseRead()
  const releaseSync = fixture.github.hold()
  await fixture.github.received(before + 2)
  change()
  releaseSync()
  return pressing
}

test('pressing Run refuses, opening no Bench, when a Blocker opens on GitHub between the read and the sync, and returns the row without a button', async () => {
  const fixture = withOrigin()
  fixture.github.issue('acme/lib#3', { title: 'Upstream fix' })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.track(ref)

  const pressed = await pressHeldUntilSync(fixture, () =>
    fixture.github.issue(ref, {
      title: 'Ship it',
      labels: ['ready-for-agent'],
      blockedBy: ['acme/lib#3'],
    }),
  )

  expect(pressed).toEqual({ ref, button: null, reason: `${ref} is blocked by acme/lib#3` })
  expect(await fixture.client.bench.list()).toEqual([])
  expect(tabCount(fixture)).toBe(0)
})

test('pressing Run refuses, opening no Bench, when the Issue is closed on GitHub between the read and the sync', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.track(ref)

  const pressed = await pressHeldUntilSync(fixture, () =>
    fixture.github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] }),
  )

  expect(pressed).toEqual({ ref, button: null, reason: `${ref} is a closed Issue` })
  expect(await fixture.client.bench.list()).toEqual([])
  expect(tabCount(fixture)).toBe(0)
})

test('pressing Run picks the prompt from the Issue read when the sync that follows fails, not from the older copy', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })
  await fixture.track(ref)
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  const pressed = await pressHeldUntilSync(fixture, () => fixture.github.fail('acme/app'))

  expect(pressed).toEqual({ ref, button: { kind: 'tackle', run: 'running' }, reason: null })
  expect(await typedClaude(fixture)).toEqual(["claude '/tackle'\r"])
})

test('pressing a Run fails without tracking when GitHub cannot be read', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  fixture.github.fail('acme/app')

  const error = await failure(fixture.client.press({ ref, run: 'new' }))

  expect(error.code).toBe('BAD_GATEWAY')
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('pressing a Run of an Issue GitHub does not return gives the row with no button, tracking nothing', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  expect(await fixture.client.press({ ref: 'acme/app#99', run: 'new' })).toEqual({
    ref: 'acme/app#99',
    button: null,
    reason: null,
  })
  expect(fixture.db.select().from(task).all()).toEqual([])
})

async function claudeStarted(fixture: Fixture, terminalSessionId: string, sessionId = 's-1') {
  const transcript = join(fixture.home, 'transcripts', `${sessionId}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{}\n')
  const fields = {
    cwd: join(fixture.home, 'worktrees/acme/app/issue-12'),
    transcript_path: transcript,
  }
  await fixture.hook(terminalSessionId, sessionId, 'SessionStart', { source: 'startup', ...fields })
  return async () =>
    fixture.hook(terminalSessionId, sessionId, 'SessionEnd', {
      reason: 'prompt_input_exit',
      ...fields,
    })
}

// in-place の Bench は checkout が在れば git を呼ばない。
async function liveRun(fixture: Fixture, labels = ['ready-for-agent']) {
  fixture.github.issue(ref, { title: 'Ship it', labels })
  fixture.taskLedger.start()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const started = await fixture.client.run({ ref, inPlace: true })
  return claudeStarted(fixture, started.terminalSessionId)
}

test('an Issue whose Task has a live Run gets a running button, and pressing a Run shown before gives that button back, opening no Tab', async () => {
  const fixture = setup()
  await liveRun(fixture)
  const tabs = tabCount(fixture)

  const running = { ref, button: { kind: 'tackle', run: 'running' }, reason: null } as const
  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({ buttons: [running] })
  expect(await fixture.client.press({ ref, run: 'new' })).toEqual(running)
  expect(tabCount(fixture)).toBe(tabs)
})

test('pressing Resume of a Task whose Run is live again does nothing and gives the running button', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  await fixture.client.run({ ref })
  const tabs = tabCount(fixture)

  expect(await fixture.client.press({ ref, run: 'resume' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'running' },
    reason: null,
  })
  expect(tabCount(fixture)).toBe(tabs)
})

test('pressing a Run of a Task whose Run has ended since does not resume it and gives the resume button', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  const tabs = tabCount(fixture)

  expect(await fixture.client.press({ ref, run: 'new' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'resume' },
    reason: null,
  })
  expect(tabCount(fixture)).toBe(tabs)
})

test('pressing Resume of a Task whose Bench was opened anew since starts no Run and gives the Run button', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  await fixture.client.close({ ref, force: true })
  await fixture.client.reopen({ ref })
  const tabs = tabCount(fixture)

  expect(await fixture.client.press({ ref, run: 'resume' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'new' },
    reason: null,
  })
  expect(tabCount(fixture)).toBe(tabs)
  expect(await fixture.client.bench.list()).toEqual([])
})

test('an Issue whose Task has an ended Run gets a resume button, and pressing it resumes claude sending no prompt and gives the running button', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
  expect(await fixture.client.press({ ref, run: 'resume' })).toEqual({
    ref,
    button: { kind: 'tackle', run: 'running' },
    reason: null,
  })
  expect((await typedClaude(fixture, 2)).at(-1)).toBe("claude --resume 's-1'\r")
})

function blockOnGitHub(fixture: Fixture) {
  fixture.github.issue('acme/lib#3', { title: 'Upstream fix' })
  fixture.github.issue(ref, {
    title: 'Ship it',
    labels: ['ready-for-agent'],
    blockedBy: ['acme/lib#3'],
  })
}

test('an Issue with an open Blocker whose Task has a live Run gets a running button', async () => {
  const fixture = setup()
  await liveRun(fixture)
  blockOnGitHub(fixture)

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'running' }, reason: null }],
  })
})

test('an Issue with an open Blocker whose Task has an ended Run gets a resume button, and pressing it resumes claude sending no prompt', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  blockOnGitHub(fixture)

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
  const requested = fixture.github.requests.length
  await fixture.client.press({ ref, run: 'resume' })
  // 押した時に Issue を引き直す 1 本だけで、resume は sync しない。
  expect(fixture.github.requests).toHaveLength(requested + 1)
  expect((await typedClaude(fixture, 2)).at(-1)).toBe("claude --resume 's-1'\r")
})

test('a closed Issue whose open Task has a live Run gets a running button, and one with an ended Run gets a resume button', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  fixture.github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'running' }, reason: null }],
  })
  await end()
  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
})

test('an Issue whose labels pick no prompt gets a resume button without a kind once its Task has an ended Run', async () => {
  const fixture = setup()
  const end = await liveRun(fixture, ['ready-for-human'])
  await end()

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { run: 'resume' }, reason: null }],
  })
})

test('an Issue whose labels pick no prompt gets a running button without a kind while its Task has a live Run', async () => {
  const fixture = setup()
  await liveRun(fixture, ['ready-for-human'])

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { run: 'running' }, reason: null }],
  })
})

test('a closed Task whose claude is still its live Run gets a reopen button', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  fixture.taskLedger.start()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const { terminalSessionId } = await fixture.client.run({ ref, inPlace: true })
  await claudeStarted(fixture, terminalSessionId)

  await fixture.client.close({ ref, terminalSessionId })

  expect((await fixture.client.list({})).tasks).toEqual([])
  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { run: 'reopen' }, reason: null }],
  })
})

const subIssue = 'acme/app#13'

// spec と子の Task を同じ checkout の in-place の Bench で run し、spec の claude だけを起動させる。
async function specAndChild(fixture: Fixture) {
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue(subIssue, { title: 'Part', labels: ['ready-for-agent'], parent: ref })
  fixture.taskLedger.start()
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  const childRun = await fixture.client.run({ ref: subIssue, inPlace: true })
  const endChild = await claudeStarted(fixture, childRun.terminalSessionId, 's-part')
  const specRun = await fixture.client.run({ ref, inPlace: true })
  return { endChild, startSpec: () => claudeStarted(fixture, specRun.terminalSessionId, 's-spec') }
}

test('a sub-issue with an ended Run gets no button while its spec has a live Run, and pressing a Resume shown before gives that row back', async () => {
  const fixture = setup()
  const { endChild, startSpec } = await specAndChild(fixture)
  await endChild()
  await startSpec()

  expect(await fixture.client.runButtons({ refs: [subIssue] })).toEqual({
    buttons: [
      {
        ref: subIssue,
        button: null,
        reason: `${subIssue} is under ${ref}, a spec with a live Run`,
      },
    ],
  })
  const tabs = tabCount(fixture)
  expect(await fixture.client.press({ ref: subIssue, run: 'resume' })).toEqual({
    ref: subIssue,
    button: null,
    reason: `${subIssue} is under ${ref}, a spec with a live Run`,
  })
  expect(tabCount(fixture)).toBe(tabs)
})

test('a run of a sub-issue closed on GitHub is refused while its spec, counting another open sub-issue on GitHub, has a live Run', async () => {
  const fixture = setup()
  fixture.github.issue('acme/app#14', { title: 'Other part', parent: ref })
  const { endChild, startSpec } = await specAndChild(fixture)
  await endChild()
  await startSpec()
  fixture.github.issue(subIssue, {
    title: 'Part',
    state: 'closed',
    labels: ['ready-for-agent'],
    parent: ref,
  })
  await fixture.client.sync({ ref: subIssue })

  expect(await failure(fixture.client.run({ ref: subIssue }))).toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: `${subIssue} is under ${ref}, a spec with a live Run; pass --force to run it anyway`,
  })
})

test('pressing Resume of a sub-issue whose parent has stopped being a spec on GitHub resumes it, though the copy still holds the parent as a spec with a live Run', async () => {
  const fixture = setup()
  const { endChild, startSpec } = await specAndChild(fixture)
  await endChild()
  await startSpec()
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-human'] })

  expect(await fixture.client.press({ ref: subIssue, run: 'resume' })).toEqual({
    ref: subIssue,
    button: { kind: 'tackle', run: 'running' },
    reason: null,
  })
  expect((await typedClaude(fixture, 3)).at(-1)).toBe("claude --resume 's-part'\r")
})

test('a sub-issue with a live Run gets a running button while its spec has a live Run', async () => {
  const fixture = setup()
  const { startSpec } = await specAndChild(fixture)
  await startSpec()

  expect(await fixture.client.runButtons({ refs: [subIssue] })).toEqual({
    buttons: [{ ref: subIssue, button: { kind: 'tackle', run: 'running' }, reason: null }],
  })
})

test('a Task whose repo was renamed before any sync still gets its resume button by the new name, and resumes claude without the prompt', async () => {
  const fixture = setup()
  const end = await liveRun(fixture, ['needs-triage'])
  await end()
  fixture.github.renameRepo('acme/app', 'acme/renamed')
  const renamed = 'acme/renamed#12'

  expect(await fixture.client.runButtons({ refs: [renamed] })).toEqual({
    buttons: [{ ref: renamed, button: { kind: 'triage', run: 'resume' }, reason: null }],
  })
  await fixture.client.press({ ref: renamed, run: 'resume' })
  expect((await typedClaude(fixture, 2)).at(-1)).toBe("claude --resume 's-1'\r")
})

test('an Issue that GitHub now gives another node ID under the same name and number does not take the button state of the Task tracked there, and pressing its Run fails instead of resuming that Task', async () => {
  const fixture = setup()
  const end = await liveRun(fixture, ['needs-triage'])
  await end()
  fixture.db.update(issue).set({ nodeId: 'an-issue-of-the-repo-that-had-this-name' }).run()

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'triage', run: 'new' }, reason: null }],
  })
  const refused = await failure(fixture.client.press({ ref, run: 'new' }))
  expect(refused.message).toContain('now another issue on GitHub')
  expect(
    fixture.ptyd.sessionRequests().some((op) => op.op === 'write' && op.data.includes('--resume')),
  ).toBe(false)
})

test('a Task whose Bench was closed and reopened gets a button for a new Run, not a resume', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  await fixture.client.close({ ref, force: true })
  await fixture.client.reopen({ ref })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('no sub-issue of a spec gets a button while the spec has a live Run, whatever its labels', async () => {
  const fixture = setup()
  const children = ['acme/app#13', 'acme/app#14', 'acme/app#15']
  fixture.github.issue(children[0]!, { title: 'Part', labels: ['ready-for-agent'], parent: ref })
  fixture.github.issue(children[1]!, { title: 'Untriaged', labels: [], parent: ref })
  fixture.github.issue(children[2]!, { title: 'Ask', labels: ['wayfinder:task'], parent: ref })

  await liveRun(fixture)

  expect(await fixture.client.runButtons({ refs: [ref, ...children] })).toEqual({
    buttons: [
      { ref, button: { kind: 'implement-spec', run: 'running' }, reason: null },
      ...children.map((child) => ({
        ref: child,
        button: null,
        reason: `${child} is under ${ref}, a spec with a live Run`,
      })),
    ],
  })
  expect(await fixture.client.press({ ref: children[1]!, run: 'new' })).toEqual({
    ref: children[1]!,
    button: null,
    reason: `${children[1]} is under ${ref}, a spec with a live Run`,
  })
})

test.each([
  ['a triage Issue', ['needs-triage'], ['ready-for-agent'], 'tackle'],
  ['a wayfinder map', ['wayfinder:map'], ['wayfinder:task'], 'wayfinder'],
] as const)(
  'a sub-issue of %s with a live Run keeps its button',
  async (_, parentLabels, childLabels, kind) => {
    const fixture = setup()
    const child = 'acme/app#13'
    fixture.github.issue(child, { title: 'Part', labels: [...childLabels], parent: ref })

    await liveRun(fixture, [...parentLabels])

    expect(await fixture.client.runButtons({ refs: [child] })).toEqual({
      buttons: [{ ref: child, button: { kind, run: 'new' }, reason: null }],
    })
  },
)

test('pressing the Run of a sub-issue whose spec gets a live Run while it is being started gives the row with no button', async () => {
  const fixture = withOrigin()
  const child = 'acme/app#13'
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue(child, { title: 'Part', labels: ['ready-for-agent'], parent: ref })
  fixture.taskLedger.start()
  await fixture.client.press({ ref, run: 'new' })
  const [specTab] = fixture.db.select().from(tab).all()

  // 子が GitHub の答えを見て決めた後、track の往復の間に spec の claude が起動する。
  const releaseRead = fixture.github.hold()
  const before = fixture.github.requests.length
  const pressing = fixture.client.press({ ref: child, run: 'new' })
  await fixture.github.received(before + 1)
  releaseRead()
  const releaseTrack = fixture.github.hold()
  await fixture.github.received(before + 2)
  await claudeStarted(fixture, specTab!.terminalSessionId)
  releaseTrack()

  expect(await pressing).toEqual({
    ref: child,
    button: null,
    reason: `${child} is under ${ref}, a spec with a live Run`,
  })
  expect(tabCount(fixture)).toBe(1)
})

test('a sub-issue of a spec whose Run has ended gets a tackle button', async () => {
  const fixture = setup()
  const child = 'acme/app#13'
  fixture.github.issue(child, { title: 'Part', labels: ['ready-for-agent'], parent: ref })

  const end = await liveRun(fixture)
  await end()

  expect(await fixture.client.runButtons({ refs: [child] })).toEqual({
    buttons: [{ ref: child, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('no Issue gets a button while gh is logged out', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  github.logOut()

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: null }],
  })
})
