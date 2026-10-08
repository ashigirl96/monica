import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { agentSession } from './schema.ts'
import { cleanUp, setup, stderrLines } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

function setupUnread() {
  const passed: string[][] = []
  return { passed, ...setup({ unread: (terminalSessionIds) => passed.push(terminalSessionIds) }) }
}

function waitIn(terminalSessionId: string, sessionId: string) {
  return {
    terminalSessionId,
    payload: {
      session_id: sessionId,
      transcript_path: `/transcripts/${sessionId}.jsonl`,
      cwd: '/work',
      hook_event_name: 'Stop',
    },
  }
}

test('the Workbench Ledger passes the unread Terminal Sessions once when it starts and again when a notified wait adds one', async () => {
  const { passed, workbenchLedger, client, settled } = setupUnread()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)

  await workbenchLedger.start()
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))

  expect(passed).toEqual([[], [tab.terminalSessionId]])
})

test('seeing the last unread Agent Session passes no Terminal Session', async () => {
  const { passed, workbenchLedger, client, settled } = setupUnread()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()
  const [listed] = await client.agentSession.list()

  await client.agentSession.markSeen({ sessionId: 's-1', notifiedAt: listed!.notifiedAt! })

  expect(passed).toEqual([[tab.terminalSessionId], []])
})

test('an unread Agent Session in a pinned Tab counts like any other, in the order of the Terminal Session ids', async () => {
  const { passed, workbenchLedger, client, settled } = setupUnread()
  const pinned = (await client.runspace.create(size)).tab
  const other = (await client.runspace.create(size)).tab
  await client.tab.pin({ id: pinned.id })
  for (const tab of [pinned, other]) await settled(tab.terminalSessionId)
  await workbenchLedger.start()

  await client.agentSession.recordHook(waitIn(other.terminalSessionId, 's-other'))
  await client.agentSession.recordHook(waitIn(pinned.terminalSessionId, 's-pinned'))

  expect(passed).toEqual([
    [],
    [other.terminalSessionId],
    [pinned.terminalSessionId, other.terminalSessionId].toSorted(),
  ])
})

test('a change that leaves the unread Terminal Sessions as they were passes nothing', async () => {
  const { passed, workbenchLedger, client, settled } = setupUnread()
  const { runspaceId, tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  await client.tab.open({ runspaceId, ...size })

  expect(passed).toEqual([[tab.terminalSessionId]])
})

test('an unread Agent Session whose hook arrives from another Tab passes the new Terminal Session though the count stays', async () => {
  const { passed, workbenchLedger, client, settled } = setupUnread()
  const before = (await client.runspace.create(size)).tab
  const after = (await client.runspace.create(size)).tab
  for (const tab of [before, after]) await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(before.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  await client.agentSession.recordHook(waitIn(after.terminalSessionId, 's-1'))

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
  expect(passed).toEqual([[before.terminalSessionId], [after.terminalSessionId]])
})

test('closing the Tab of an unread Agent Session takes it out once its shell exits', async () => {
  const { passed, ptyd, workbenchLedger, client, settled } = setupUnread()
  const { runspaceId, tab } = await client.runspace.create(size)
  await client.tab.open({ runspaceId, ...size })
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  await client.tab.close({ id: tab.id })
  await ptyd.received((op) => op.op === 'terminate' && op.session_id === tab.terminalSessionId)
  ptyd.exit(tab.terminalSessionId, null)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect(passed).toEqual([[tab.terminalSessionId], []])
})

test('a transaction that signals a change and then rolls back passes nothing', async () => {
  const { passed, db, workbenchLedger, client, settled } = setupUnread()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  expect(() =>
    db.transaction((tx) => {
      tx.update(agentSession)
        .set({ seenAt: new Date() })
        .where(eq(agentSession.sessionId, 's-1'))
        .run()
      workbenchLedger.createRunspace(tx, { cwd: '/work' })
      throw new Error('the caller failed after the signal')
    }),
  ).toThrow()
  await Promise.resolve()

  expect(passed).toEqual([[tab.terminalSessionId]])
})

test('a restarted Backend passes the unread Terminal Sessions it finds before monica-ptyd answers', async () => {
  const { passed, client, restartBackend, settled } = setupUnread()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))

  const started = restartBackend().workbenchLedger.start()

  expect(passed).toEqual([[tab.terminalSessionId]])
  await started
})

test('a shell that exits takes its unread Agent Session out', async () => {
  const { passed, ptyd, workbenchLedger, client, settled } = setupUnread()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  ptyd.exit(tab.terminalSessionId, 0)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect(passed).toEqual([[tab.terminalSessionId], []])
})

test('failing to pass the unread Terminal Sessions leaves the hook recorded, with one line on stderr', async () => {
  const { workbenchLedger, client, settled } = setup({
    unread: () => {
      throw new Error('stdout is closed')
    },
  })
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  const lines = stderrLines()

  await workbenchLedger.start()
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
  expect(lines()).toContainEqual(expect.stringContaining('stdout is closed'))
})
