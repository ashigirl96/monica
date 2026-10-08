import { afterEach, expect, test } from 'bun:test'

import { eq } from 'drizzle-orm'

import { agentSession } from './schema.ts'
import { cleanUp, setup, stderrLines } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

function setupBadged() {
  const badged: number[] = []
  return { badged, ...setup({ badge: (count) => badged.push(count) }) }
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

test('the Workbench Ledger badges the unread count once when it starts and again when a notified wait adds one', async () => {
  const { badged, workbenchLedger, client, settled } = setupBadged()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)

  await workbenchLedger.start()
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))

  expect(badged).toEqual([0, 1])
})

test('seeing the last unread Agent Session badges 0', async () => {
  const { badged, workbenchLedger, client, settled } = setupBadged()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()
  const [listed] = await client.agentSession.list()

  await client.agentSession.markSeen({ sessionId: 's-1', notifiedAt: listed!.notifiedAt! })

  expect(badged).toEqual([1, 0])
})

test('an unread Agent Session in a pinned Tab counts like any other', async () => {
  const { badged, workbenchLedger, client, settled } = setupBadged()
  const pinned = (await client.runspace.create(size)).tab
  const other = (await client.runspace.create(size)).tab
  await client.tab.pin({ id: pinned.id })
  for (const tab of [pinned, other]) await settled(tab.terminalSessionId)
  await workbenchLedger.start()

  await client.agentSession.recordHook(waitIn(pinned.terminalSessionId, 's-pinned'))
  await client.agentSession.recordHook(waitIn(other.terminalSessionId, 's-other'))

  expect(badged).toEqual([0, 1, 2])
})

test('a change that leaves the count as it was badges nothing', async () => {
  const { badged, workbenchLedger, client, settled } = setupBadged()
  const { runspaceId, tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  await client.tab.open({ runspaceId, ...size })

  expect(badged).toEqual([1])
})

test('closing the Tab of an unread Agent Session takes it out of the count once its shell exits', async () => {
  const { badged, ptyd, workbenchLedger, client, settled } = setupBadged()
  const { runspaceId, tab } = await client.runspace.create(size)
  await client.tab.open({ runspaceId, ...size })
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  await client.tab.close({ id: tab.id })
  await ptyd.received((op) => op.op === 'terminate' && op.session_id === tab.terminalSessionId)
  ptyd.exit(tab.terminalSessionId, null)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect(badged).toEqual([1, 0])
})

test('a transaction that signals a change and then rolls back badges nothing', async () => {
  const { badged, db, workbenchLedger, client, settled } = setupBadged()
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

  expect(badged).toEqual([1])
})

test('a restarted Backend badges the unread count it finds before tania-ptyd answers', async () => {
  const { badged, client, restartBackend, settled } = setupBadged()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))

  const started = restartBackend().workbenchLedger.start()

  expect(badged).toEqual([1])
  await started
})

test('a shell that exits takes its unread Agent Session out of the count', async () => {
  const { badged, ptyd, workbenchLedger, client, settled } = setupBadged()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook(waitIn(tab.terminalSessionId, 's-1'))
  await workbenchLedger.start()

  ptyd.exit(tab.terminalSessionId, 0)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect(badged).toEqual([1, 0])
})

test('a badge that throws leaves the hook recorded, with one line on stderr', async () => {
  const { workbenchLedger, client, settled } = setup({
    badge: () => {
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
