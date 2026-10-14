import { afterEach, expect, test } from 'bun:test'

import { terminalSession } from './schema.ts'
import { terminating } from './terminal-session-status.ts'
import { cleanUp, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

test('a closed Tab leaves its Terminal Session Terminating until the exit is recorded, and an open Tab does not', async () => {
  const { ptyd, db, client, settled } = setup()
  const { runspaceId, tab: kept } = await client.runspace.create(size)
  const closed = await client.tab.open({ runspaceId, ...size })
  await settled(kept.terminalSessionId)
  await settled(closed.terminalSessionId)
  const terminatingIds = () =>
    db
      .select({ id: terminalSession.id })
      .from(terminalSession)
      .where(terminating(db, terminalSession.id))
      .all()
      .map((row) => row.id)
  expect(terminatingIds()).toEqual([])

  await client.tab.close({ id: closed.id })

  expect(terminatingIds()).toEqual([closed.terminalSessionId])
  await ptyd.received((op) => op.op === 'terminate' && op.session_id === closed.terminalSessionId)
  expect(terminatingIds()).toEqual([closed.terminalSessionId])
  ptyd.exit(closed.terminalSessionId, null)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === closed.terminalSessionId)
  expect(terminatingIds()).toEqual([])
})
