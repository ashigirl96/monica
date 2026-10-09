import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { issue, task } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'

type Fixture = ReturnType<typeof setup>

// runFromButton は worktree の Bench を開くので、新しい Bench まで進むテストだけが origin を要る。
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

test('a wayfinder Issue with no parent map gets no button, and running it is refused', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ask it', labels: ['wayfinder:grilling'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: expect.stringContaining('no map above it') }],
  })
  expect((await failure(fixture.client.runFromButton({ ref }))).code).toBe('PRECONDITION_FAILED')
})

test('a wayfinder Issue under a parent that is not a map gets no button, and running it is refused', async () => {
  const fixture = setup()
  fixture.github.issue('acme/app#7', { title: 'Plain', labels: ['enhancement'] })
  fixture.github.issue(ref, { title: 'Ask it', labels: ['wayfinder:task'], parent: 'acme/app#7' })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: expect.stringContaining('acme/app#7') }],
  })
  const refused = await failure(fixture.client.runFromButton({ ref }))
  expect(refused.code).toBe('PRECONDITION_FAILED')
  expect(refused.message).toContain('acme/app#7')
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

test('a closed Task gets a reopen button, running from it is refused, and once reopened it gets its Run button back', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
  await client.close({ ref })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { run: 'reopen' }, reason: null }],
  })
  const refusal = await failure(client.runFromButton({ ref }))
  expect([refusal.code, refusal.message]).toEqual([
    'PRECONDITION_FAILED',
    `${ref} is a closed Task; reopen it to run it`,
  ])

  await client.reopenFromButton({ ref })
  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('reopening from a button reads the Issue anew and refuses a Task whose Issue was closed since, leaving it closed', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
  await client.close({ ref })
  github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  const refusal = await failure(client.reopenFromButton({ ref }))
  expect([refusal.code, refusal.message]).toEqual([
    'PRECONDITION_FAILED',
    `${ref} is a closed Issue`,
  ])
  expect((await client.list({ closed: true })).tasks.map((t) => t.ref)).toEqual([ref])
})

test('a closed Task whose repo was renamed before any sync gets its reopen button by the new name, and reopens from it', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
  await client.close({ ref })
  github.renameRepo('acme/app', 'acme/renamed')
  const renamed = 'acme/renamed#12'

  expect(await client.runButtons({ refs: [renamed] })).toEqual({
    buttons: [{ ref: renamed, button: { run: 'reopen' }, reason: null }],
  })
  expect((await client.reopenFromButton({ ref: renamed })).ref).toBe(renamed)
  expect(await client.runButtons({ refs: [renamed] })).toEqual({
    buttons: [{ ref: renamed, button: { kind: 'tackle', run: 'new' }, reason: null }],
  })
})

test('reopening from a button refuses a Task whose Issue is closed between the button and the sync of reopen, leaving it closed', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.track({ ref })
  await fixture.client.close({ ref })

  const releaseRead = fixture.github.hold()
  const before = fixture.github.requests.length
  const reopening = failure(fixture.client.reopenFromButton({ ref }))
  await fixture.github.received(before + 1)
  releaseRead()
  const releaseSync = fixture.github.hold()
  await fixture.github.received(before + 2)
  fixture.github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })
  releaseSync()

  const refusal = await reopening
  expect([refusal.code, refusal.message]).toEqual([
    'PRECONDITION_FAILED',
    `${ref} is a closed Issue`,
  ])
  expect((await fixture.client.list({ closed: true })).tasks.map((t) => t.ref)).toEqual([ref])
})

test('reopening from a button refuses an open Task', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })

  const refusal = await failure(client.reopenFromButton({ ref }))
  expect([refusal.code, refusal.message]).toEqual([
    'PRECONDITION_FAILED',
    `${ref} is not a closed Task`,
  ])
})

test('a closed Task of a closed Issue gets no reopen button', async () => {
  const { github, client } = setup()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
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

// run は Tab を書いて commit したら返り、Write はその後で ptyd に届く。
async function typedInto(fixture: Fixture, terminalSessionId: string) {
  await fixture.ptyd.received((op) => op.op === 'write' && op.session_id === terminalSessionId)
  return fixture.ptyd.sessionRequests().filter((op) => op.session_id === terminalSessionId)
}

test('running from a tackle button tracks the Issue and types claude with /tackle into a Tab of its Bench', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  const output = await fixture.client.runFromButton({ ref })

  expect(output).toMatchObject({ ref, tracked: true, benchCreated: true, resumed: null })
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('running from a triage button types claude with /triage and the Issue number', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'triage', run: 'new' }, reason: null }],
  })
  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/triage #12'\r",
  })
})

test('running from a wayfinder map button types claude with /wayfinder and the map, even when it has open sub-issues', async () => {
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
  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/wayfinder 12'\r",
  })
})

test('running from the button of a ready-for-agent Issue with an open sub-issue types claude with /implement-spec and the Issue number', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue('acme/app#13', { title: 'Done part', state: 'closed', parent: ref })
  fixture.github.issue('acme/app#14', { title: 'Next part', parent: ref })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'implement-spec', run: 'new' }, reason: null }],
  })
  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/implement-spec #12'\r",
  })
})

test('a ready-for-agent Issue whose sub-issues are all closed gets no button, and running it is refused', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue('acme/app#13', { title: 'Done part', state: 'closed', parent: ref })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null, reason: expect.stringContaining('sub-issues are all closed') }],
  })
  expect((await failure(fixture.client.runFromButton({ ref }))).code).toBe('PRECONDITION_FAILED')
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

test('running from the button of a wayfinder Issue under a map types claude with /wayfinder, its map and itself into a Bench of its own Task', async () => {
  const fixture = withOrigin()
  fixture.github.issue('acme/app#7', { title: 'Map it', labels: ['wayfinder:map'] })
  fixture.github.issue(ref, {
    title: 'Ask it',
    labels: ['wayfinder:grilling'],
    parent: 'acme/app#7',
  })

  const output = await fixture.client.runFromButton({ ref })

  expect(output).toMatchObject({ ref, tracked: true, benchCreated: true })
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/wayfinder 7 12'\r",
  })
  expect((await fixture.client.list({})).tasks.map((t) => t.ref)).toEqual([ref])
})

test('running from a button types the prompt of the labels the Issue has when it runs, not when the button was told', async () => {
  const fixture = withOrigin()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.runButtons({ refs: [ref] })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })

  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/triage #12'\r",
  })
})

test('running from a button reads the labels anew and refuses an Issue that has lost its button, opening no Bench', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.runButtons({ refs: [ref] })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-human'] })

  const error = await failure(fixture.client.runFromButton({ ref }))

  expect(error.code).toBe('PRECONDITION_FAILED')
  expect(error.message).toContain(ref)
  expect(await fixture.client.bench.list()).toEqual([])
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('running from a button refuses an Issue with an open Blocker, naming it', async () => {
  const fixture = setup()
  fixture.github.issue('acme/lib#3', { title: 'Upstream fix' })
  fixture.github.issue(ref, {
    title: 'Ship it',
    labels: ['ready-for-agent'],
    blockedBy: ['acme/lib#3'],
  })

  const error = await failure(fixture.client.runFromButton({ ref }))

  expect(error.code).toBe('BLOCKED')
  expect(error.data).toEqual({ blockers: ['acme/lib#3'] })
  expect(await fixture.client.bench.list()).toEqual([])
})

test('running from a button fails without tracking when GitHub cannot be read', async () => {
  const fixture = setup()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  fixture.github.fail('acme/app')

  const error = await failure(fixture.client.runFromButton({ ref }))

  expect(error.code).toBe('BAD_GATEWAY')
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

test('an Issue whose Task has a live Run gets a running button, and running from it is refused', async () => {
  const fixture = setup()
  await liveRun(fixture)

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'running' }, reason: null }],
  })
  expect((await failure(fixture.client.runFromButton({ ref }))).code).toBe('CONFLICT')
})

test('an Issue whose Task has an ended Run gets a resume button, and running from it resumes claude sending no prompt', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
  const output = await fixture.client.runFromButton({ ref })
  expect(output.resumed).toBe('s-1')
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude --resume 's-1'\r",
  })
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

test('an Issue with an open Blocker whose Task has an ended Run gets a resume button, and running from it resumes claude sending no prompt', async () => {
  const fixture = setup()
  const end = await liveRun(fixture)
  await end()
  blockOnGitHub(fixture)

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
  const requested = fixture.github.requests.length
  const output = await fixture.client.runFromButton({ ref })
  // 押した時に Issue を引き直す 1 本だけで、resume は sync しない。
  expect(fixture.github.requests).toHaveLength(requested + 1)
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude --resume 's-1'\r",
  })
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

test('a sub-issue with an ended Run gets no button while its spec has a live Run, and running from it is refused', async () => {
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
  const refused = await failure(fixture.client.runFromButton({ ref: subIssue }))
  expect([refused.code, refused.message]).toEqual([
    'PRECONDITION_FAILED',
    `${subIssue} is under ${ref}, a spec with a live Run`,
  ])
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
  const output = await fixture.client.runFromButton({ ref: renamed })
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude --resume 's-1'\r",
  })
})

test('an Issue that GitHub now gives another node ID under the same name and number does not take the button state of the Task tracked there, and running it is refused instead of resuming that Task', async () => {
  const fixture = setup()
  const end = await liveRun(fixture, ['needs-triage'])
  await end()
  fixture.db.update(issue).set({ nodeId: 'an-issue-of-the-repo-that-had-this-name' }).run()

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'triage', run: 'new' }, reason: null }],
  })
  const refused = await failure(fixture.client.runFromButton({ ref }))
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
  const refused = await failure(fixture.client.runFromButton({ ref: children[1]! }))
  expect(refused.code).toBe('PRECONDITION_FAILED')
  expect(refused.message).toContain(ref)
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

test('a sub-issue whose run started before its spec got a live Run is refused once the spec has one', async () => {
  const fixture = withOrigin()
  const child = 'acme/app#13'
  fixture.github.issue(ref, { title: 'Spec it', labels: ['ready-for-agent'] })
  fixture.github.issue(child, { title: 'Part', labels: ['ready-for-agent'], parent: ref })
  fixture.taskLedger.start()
  const spec = await fixture.client.runFromButton({ ref })

  // 子が GitHub の答えを見て決めた後、track の往復の間に spec の claude が起動する。
  const releaseRead = fixture.github.hold()
  const before = fixture.github.requests.length
  const running = failure(fixture.client.runFromButton({ ref: child }))
  await fixture.github.received(before + 1)
  releaseRead()
  const releaseTrack = fixture.github.hold()
  await fixture.github.received(before + 2)
  await claudeStarted(fixture, spec.terminalSessionId)
  releaseTrack()

  const refused = await running
  expect(refused.code).toBe('PRECONDITION_FAILED')
  expect(refused.message).toContain(ref)
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
