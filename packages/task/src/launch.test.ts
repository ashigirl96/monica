import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { mkdirSync } from 'node:fs'

import { tab } from '@monica/workbench/schema'

import { LAUNCH_TIMEOUT_MS } from './reservation.ts'
import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

const ref = 'acme/app#12'

const BEING_STARTED = `${ref} has a Run being started; to add an agent alongside, open a Tab in its Bench and run claude there`

type Fixture = ReturnType<typeof setup>

// in-place の Bench は checkout が在れば git を呼ばない。Run は Bench の Tab の claude から購読で生まれるので start する。
async function tracked() {
  const fixture = setup()
  fixture.taskLedger.start()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await fixture.client.track({ ref })
  mkdirSync(fixture.ghq.checkout('acme/app'), { recursive: true })
  return fixture
}

// 予約が残ったままだと、後の run が Tab を開く前に断られる。
async function withBench() {
  const fixture = await tracked()
  await fixture.exit((await fixture.client.run({ ref, inPlace: true })).terminalSessionId)
  return fixture
}

const tabCount = ({ db }: Pick<Fixture, 'db'>) => db.select().from(tab).all().length

const callers = {
  cli: (fixture: Fixture) => fixture.client.run({ ref }),
  button: (fixture: Fixture) => fixture.client.runFromButton({ ref }),
}

test.each([
  ['cli', 'cli'],
  ['cli', 'button'],
  ['button', 'cli'],
  ['button', 'button'],
] as const)(
  'of two runs of one Task sent at once, from %s and from %s, only one opens a Tab and the other is refused with CONFLICT',
  async (first, second) => {
    const fixture = await withBench()
    const before = tabCount(fixture)

    const settled = await Promise.allSettled([callers[first](fixture), callers[second](fixture)])

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    expect(settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []))).toMatchObject([
      { code: 'CONFLICT', message: BEING_STARTED },
    ])
    expect(tabCount(fixture)).toBe(before + 1)
  },
)

test('between opening its Tab and the SessionStart of its claude, a Task gets a running button, and a run of it is refused', async () => {
  const fixture = await tracked()
  await fixture.client.run({ ref, inPlace: true })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'running' }, reason: null }],
  })
  expect(await failure(fixture.client.run({ ref }))).toMatchObject({
    code: 'CONFLICT',
    message: BEING_STARTED,
  })
})

test('once the SessionStart makes its claude a Run, the live Run gives the running button, and when that Run ends the Task can be resumed', async () => {
  const fixture = await tracked()
  const { terminalSessionId } = await fixture.client.run({ ref, inPlace: true })

  await fixture.hook(terminalSessionId, 's-1', 'SessionStart', { source: 'startup' })
  expect((await failure(fixture.client.run({ ref }))).message).toStartWith(
    `${ref} has a live Run (s-1 `,
  )
  await fixture.hook(terminalSessionId, 's-1', 'SessionEnd', { reason: 'exit' })

  expect(await fixture.client.runButtons({ refs: [ref] })).toEqual({
    buttons: [{ ref, button: { kind: 'tackle', run: 'resume' }, reason: null }],
  })
  expect(await fixture.client.run({ ref })).toMatchObject({ resumed: 's-1' })
})

test('when the Terminal Session of a run ends before its claude becomes a Run, the next run passes at once', async () => {
  const fixture = await tracked()
  const { terminalSessionId } = await fixture.client.run({ ref, inPlace: true })

  await fixture.exit(terminalSessionId)

  expect(await fixture.client.run({ ref })).toMatchObject({ ref, resumed: null })
})

test('a run whose claude neither becomes a Run nor ends stops refusing the next run 60 seconds after it opened its Tab', async () => {
  const fixture = await tracked()
  await fixture.client.run({ ref, inPlace: true })
  const opened = Date.now()

  setSystemTime(new Date(opened + LAUNCH_TIMEOUT_MS - 1_000))
  expect((await failure(fixture.client.run({ ref }))).code).toBe('CONFLICT')
  setSystemTime(new Date(opened + LAUNCH_TIMEOUT_MS + 1))

  expect(LAUNCH_TIMEOUT_MS).toBe(60_000)
  expect(await fixture.client.run({ ref })).toMatchObject({ ref, resumed: null })
})

test('a run refused in the transaction that would open its Tab leaves no reservation, so the next run passes once the Run that refused it ends', async () => {
  const fixture = setup()
  const { client, ghq } = fixture
  fixture.taskLedger.start()
  fixture.github.issue(ref, { title: 'Ship it', labels: ['ready-for-agent'] })
  await client.track({ ref })
  const asked = Promise.withResolvers<void>()
  const cloned = Promise.withResolvers<void>()
  spyOn(ghq.client, 'get').mockImplementation(() => {
    asked.resolve()
    return cloned.promise
  })
  const running = failure(client.run({ ref, inPlace: true }))
  await asked.promise
  const [preparing] = await client.bench.list()
  const other = fixture.openTab(preparing!.runspaceId)
  await fixture.hook(other, 's-1', 'SessionStart', { source: 'startup' })
  mkdirSync(ghq.checkout('acme/app'), { recursive: true })
  cloned.resolve()
  expect((await running).code).toBe('CONFLICT')

  await fixture.hook(other, 's-1', 'SessionEnd', { reason: 'exit' })

  expect(await client.run({ ref })).toMatchObject({ ref, resumed: 's-1' })
})

test('a second run is refused before it syncs the Task with GitHub', async () => {
  const fixture = await tracked()
  await fixture.client.run({ ref, inPlace: true })
  const sent = fixture.github.requests.length

  expect((await failure(fixture.client.run({ ref }))).code).toBe('CONFLICT')
  expect(fixture.github.requests).toHaveLength(sent)
})

test('while a Run is being started, close without --force is refused with CONFLICT, and close --force passes and leaves no reservation', async () => {
  const fixture = await tracked()
  const { client } = fixture
  await client.run({ ref, inPlace: true })

  expect(await failure(client.close({ ref }))).toMatchObject({
    code: 'CONFLICT',
    message: `${ref} has a Run being started; close it once its claude starts, or pass --force to close anyway`,
  })
  await client.close({ ref, force: true })
  await client.reopen({ ref })

  expect(await client.run({ ref, inPlace: true })).toMatchObject({ ref, benchCreated: true })
})
