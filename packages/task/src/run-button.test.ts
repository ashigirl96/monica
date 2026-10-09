import { afterEach, expect, mock, test } from 'bun:test'

import { task } from './schema.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  cleanUp()
})

const ref = 'acme/app#12'

type Fixture = ReturnType<typeof withRepo>

function withRepo() {
  const fixture = setup()
  fixture.ghq.origin('acme/app', {})
  return fixture
}

test('a ready-for-agent Issue gets a tackle button', async () => {
  const { github, client } = withRepo()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle' } }],
  })
})

test('an Issue with an open Blocker gets no button, and one whose Blockers are all closed does', async () => {
  const { github, client } = withRepo()
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
      { ref, button: null },
      { ref: 'acme/app#13', button: { kind: 'tackle' } },
    ],
  })
})

test.each([['ready-for-human'], ['needs-info'], ['wontfix']])(
  'a %s Issue gets no button',
  async (label) => {
    const { github, client } = withRepo()
    github.issue(ref, { title: 'Ship it', labels: [label, 'bug'] })

    expect(await client.runButtons({ refs: [ref] })).toEqual({ buttons: [{ ref, button: null }] })
  },
)

test('a wayfinder Issue with no parent map gets no button, and running it is refused', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ask it', labels: ['wayfinder:grilling'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: null }],
  })
  expect((await failure(fixture.client.runFromButton({ ref }))).code).toBe('NO_RUN_BUTTON')
})

test.each([[[]], [['bug', 'enhancement']]])(
  'an Issue with no state label, labelled %j, gets a triage button',
  async (labels) => {
    const { github, client } = withRepo()
    github.issue(ref, { title: 'Ship it', labels })

    expect(await client.runButtons({ refs: [ref] })).toEqual({
      buttons: [{ ref, button: { kind: 'triage' } }],
    })
  },
)

test('a closed Issue gets no button', async () => {
  const { github, client } = withRepo()
  github.issue(ref, { title: 'Ship it', state: 'closed', labels: ['ready-for-agent'] })

  expect(await client.runButtons({ refs: [ref] })).toEqual({ buttons: [{ ref, button: null }] })
})

test('telling the buttons tracks no Issue', async () => {
  const { github, client, db } = withRepo()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  await client.runButtons({ refs: [ref] })

  expect(db.select().from(task).all()).toEqual([])
})

test('a closed Task gets no button', async () => {
  const { github, client } = withRepo()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
  await client.close({ ref })

  expect(await client.runButtons({ refs: [ref] })).toEqual({ buttons: [{ ref, button: null }] })
})

test('an Issue GitHub does not return, one of a failing repo and a malformed ref get no button, and the rest still do', async () => {
  const { github, client } = withRepo()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  github.issue('acme/lib#3', { title: 'Upstream fix', labels: ['ready-for-agent'] })
  github.fail('acme/lib')

  expect(
    await client.runButtons({ refs: [ref, 'acme/app#99', 'acme/lib#3', 'not a ref'] }),
  ).toEqual({
    buttons: [
      { ref, button: { kind: 'tackle' } },
      { ref: 'acme/app#99', button: null },
      { ref: 'acme/lib#3', button: null },
      { ref: 'not a ref', button: null },
    ],
  })
})

// run は Tab を書いて commit したら返り、Write はその後で ptyd に届く。
async function typedInto(fixture: Fixture, terminalSessionId: string) {
  await fixture.ptyd.received((op) => op.op === 'write' && op.session_id === terminalSessionId)
  return fixture.ptyd.sessionRequests().filter((op) => op.session_id === terminalSessionId)
}

test('running from a tackle button tracks the Issue and types claude with /tackle into a Tab of its Bench', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })

  const output = await fixture.client.runFromButton({ ref })

  expect(output).toMatchObject({ ref, tracked: true, benchCreated: true, resumed: null })
  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/tackle'\r",
  })
})

test('running from a triage button types claude with /triage and the Issue number', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'triage' } }],
  })
  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/triage #12'\r",
  })
})

test('running from a wayfinder map button types claude with /wayfinder and the map, even when it has open sub-issues', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Map it', labels: ['wayfinder:map'] })
  fixture.github.issue('acme/app#13', {
    title: 'Ask it',
    labels: ['wayfinder:grilling'],
    parent: ref,
  })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'wayfinder' } }],
  })
  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/wayfinder 12'\r",
  })
})

test.each([
  ['wayfinder:grilling'],
  ['wayfinder:prototype'],
  ['wayfinder:research'],
  ['wayfinder:task'],
])(
  'running from the button of a %s Issue types claude with /wayfinder, its map and itself into a Bench of its own Task',
  async (label) => {
    const fixture = withRepo()
    fixture.github.issue('acme/app#7', { title: 'Map it', labels: ['wayfinder:map'] })
    fixture.github.issue(ref, { title: 'Ask it', labels: [label], parent: 'acme/app#7' })

    expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
      buttons: [{ ref, button: { kind: 'wayfinder' } }],
    })
    const output = await fixture.client.runFromButton({ ref })

    expect(output).toMatchObject({ ref, tracked: true, benchCreated: true })
    expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
      data: "claude '/wayfinder 7 12'\r",
    })
    expect((await fixture.client.list({})).tasks.map((t) => t.ref)).toEqual([ref])
  },
)

test('running from a button types the prompt of the labels the Issue has when it runs, not when the button was told', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.runButtons({ refs: [ref] })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['needs-triage'] })

  const output = await fixture.client.runFromButton({ ref })

  expect((await typedInto(fixture, output.terminalSessionId)).at(-1)).toMatchObject({
    data: "claude '/triage #12'\r",
  })
})

test('running from a button reads the labels anew and refuses an Issue that has lost its button, opening no Bench', async () => {
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.runButtons({ refs: [ref] })
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-human'] })

  const error = await failure(fixture.client.runFromButton({ ref }))

  expect(error.code).toBe('NO_RUN_BUTTON')
  expect(error.message).toContain(ref)
  expect(await fixture.client.bench.list()).toEqual([])
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('running from a button refuses an Issue with an open Blocker, naming it', async () => {
  const fixture = withRepo()
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
  const fixture = withRepo()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  fixture.github.fail('acme/app')

  const error = await failure(fixture.client.runFromButton({ ref }))

  expect(error.code).toBe('BAD_GATEWAY')
  expect(fixture.db.select().from(task).all()).toEqual([])
})

test('no Issue gets a button while gh is logged out', async () => {
  const { github, client } = withRepo()
  github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  github.logOut()

  expect(await client.runButtons({ refs: [ref] })).toEqual({ buttons: [{ ref, button: null }] })
})
