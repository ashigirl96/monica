import { afterEach, expect, test } from 'bun:test'

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

import type { StudyWatchEvent } from './contract.ts'
import { type FakeClaude, init, studyFixture, until } from './study-fixture.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const { setup, watching } = studyFixture(cleanups)

const COMMAND = 'docker ps\n--all'

function askOutside(claude: FakeClaude, signal = new AbortController().signal) {
  let answer: PermissionResult | null | undefined
  const answered = claude.options.canUseTool!(
    'Bash',
    { command: COMMAND, description: 'List containers', dangerouslyDisableSandbox: true },
    { signal, toolUseID: 't1', requestId: 'r1' },
  )
  void answered.then((a) => (answer = a))
  return { answered, answer: () => answer }
}

const answeredRow = (event: StudyWatchEvent) =>
  event.type === 'message' &&
  event.message.kind === 'permission' &&
  event.message.state !== 'pending'

const permissionEvents = (events: StudyWatchEvent[]) =>
  events.flatMap((event) =>
    event.type === 'message' && event.message.kind === 'permission'
      ? [{ id: event.message.id, state: event.message.state }]
      : [],
  )

async function waitingStudy() {
  const fixture = setup()
  const { client, fake } = fixture
  const { id } = await client.start({})
  const watch = await watching(client, id)
  await client.send({ id, text: 'run docker ps' })
  await until(() => fake.claudes.length === 1)
  const claude = fake.claudes[0]!
  claude.emit(init())
  return { ...fixture, id, watch, claude }
}

test('a Bash outside the box writes a pending permission row, streams it, and shows it in get and as waitingPermission in list, holding the turn', async () => {
  const { client, id, watch, claude } = await waitingStudy()

  const asked = askOutside(claude)
  await watch.until((event) => event.type === 'message' && event.message.kind === 'permission')

  const study = await client.get({ id })
  expect(study.conversations[0]!.messages.at(-1)).toMatchObject({
    kind: 'permission',
    text: COMMAND,
    tool: null,
    reason: 'List containers',
    state: 'pending',
  })
  expect((await client.list({})).studies[0]!.waitingPermission).toBe(true)
  await Bun.sleep(20)
  expect(asked.answer()).toBeUndefined()
  expect(watch.events.some((event) => event.type === 'turn-ended')).toBe(false)
  expect(permissionEvents(watch.events)).toEqual([
    { id: study.conversations[0]!.messages.at(-1)!.id, state: 'pending' },
  ])
})

async function pendingRow() {
  const waiting = await waitingStudy()
  const asked = askOutside(waiting.claude)
  await waiting.watch.until(
    (event) => event.type === 'message' && event.message.kind === 'permission',
  )
  const rowId = permissionEvents(waiting.watch.events)[0]!.id
  return { ...waiting, asked, rowId }
}

test('allowing lets the Bash run, and the row streams again as allowed', async () => {
  const { client, id, watch, asked, rowId } = await pendingRow()

  const answered = await client.permission.answer({ id: rowId, allow: true })

  expect(answered).toMatchObject({ id: rowId, kind: 'permission', state: 'allowed' })
  expect(await asked.answered).toMatchObject({ behavior: 'allow' })
  await watch.until(answeredRow)
  expect(permissionEvents(watch.events)).toEqual([
    { id: rowId, state: 'pending' },
    { id: rowId, state: 'allowed' },
  ])
  expect((await client.list({})).studies.find((s) => s.id === id)!.waitingPermission).toBe(false)
})

test('denying refuses the Bash with a message for the Tutor, and the row streams again as denied', async () => {
  const { client, watch, asked, rowId } = await pendingRow()

  const answered = await client.permission.answer({ id: rowId, allow: false })

  expect(answered.state).toBe('denied')
  expect(await asked.answered).toEqual({
    behavior: 'deny',
    message: 'The user refused to run this command outside the box.',
  })
  await watch.until(answeredRow)
  expect(permissionEvents(watch.events)).toEqual([
    { id: rowId, state: 'pending' },
    { id: rowId, state: 'denied' },
  ])
})

test('a second answer changes nothing and returns the row as it is', async () => {
  const { client, watch, rowId } = await pendingRow()
  await client.permission.answer({ id: rowId, allow: false })
  await watch.until(answeredRow)

  const again = await client.permission.answer({ id: rowId, allow: true })

  expect(again).toMatchObject({ id: rowId, state: 'denied' })
  await Bun.sleep(20)
  expect(permissionEvents(watch.events)).toHaveLength(2)
})

test('answering a row that does not exist, or a row that is not a permission, is NOT_FOUND', async () => {
  const { client, id } = await pendingRow()
  const userRow = (await client.get({ id })).conversations[0]!.messages[0]!

  expect(userRow.kind).toBe('user')
  await expect(client.permission.answer({ id: userRow.id, allow: true })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
  await expect(client.permission.answer({ id: 999, allow: true })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('aborting the turn denies the pending row and streams it', async () => {
  const waiting = await waitingStudy()
  const aborted = new AbortController()
  const asked = askOutside(waiting.claude, aborted.signal)
  await waiting.watch.until(
    (event) => event.type === 'message' && event.message.kind === 'permission',
  )

  aborted.abort()

  expect(await asked.answered).toMatchObject({ behavior: 'deny' })
  await waiting.watch.until(answeredRow)
  expect(permissionEvents(waiting.watch.events).map((e) => e.state)).toEqual(['pending', 'denied'])
})

test('a Study Ledger made again on the same DB denies the rows left pending', async () => {
  const before = await pendingRow()

  const after = setup({ db: before.db, home: before.home })

  const rows = (await after.client.get({ id: before.id })).conversations[0]!.messages
  expect(rows.find((row) => row.id === before.rowId)!.state).toBe('denied')
  expect((await after.client.list({})).studies[0]!.waitingPermission).toBe(false)
})
