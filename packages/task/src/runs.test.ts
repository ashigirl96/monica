import { afterEach, expect, mock, setSystemTime, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { cleanUp, failure, setup } from './testing.ts'

afterEach(() => {
  mock.restore()
  setSystemTime()
  cleanUp()
})

const ref = 'acme/app#12'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 9, minute))

type Fixture = Awaited<ReturnType<typeof withBench>>

async function withBench() {
  const fixture = setup()
  fixture.taskLedger.start()
  setSystemTime(at(0))
  const runspaceId = await fixture.openBench(ref)
  return { ...fixture, runspaceId }
}

function transcriptOf({ home }: Fixture, sessionId: string, { written = true } = {}) {
  const path = join(home, 'transcripts', `${sessionId}.jsonl`)
  if (written) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  }
  return path
}

async function claudeIn(
  fixture: Fixture,
  sessionId: string,
  { startedAt, endedAt, fields = {} }: { startedAt: number; endedAt?: number; fields?: object },
) {
  const terminalSessionId = fixture.openTab(fixture.runspaceId)
  setSystemTime(at(startedAt))
  await fixture.hook(terminalSessionId, sessionId, 'SessionStart', { source: 'startup', ...fields })
  if (endedAt !== undefined) {
    setSystemTime(at(endedAt))
    await fixture.hook(terminalSessionId, sessionId, 'SessionEnd', { reason: 'exit', ...fields })
  }
  return terminalSessionId
}

test('runs lists the Runs of an open Task by their last event, newest first, live ones included', async () => {
  const fixture = await withBench()
  await claudeIn(fixture, 's-old', { startedAt: 1, endedAt: 2 })
  await claudeIn(fixture, 's-live', { startedAt: 3 })
  await claudeIn(fixture, 's-new', { startedAt: 4, endedAt: 5 })

  const listed = await fixture.client.runs({ ref })

  expect(listed).toMatchObject({ ref, title: 'Ship it', closedAt: null })
  expect(listed.runs).toEqual([
    {
      agentSessionId: 's-new',
      state: 'ended',
      origin: 'started',
      startedAt: at(4),
      lastEventAt: at(5),
      endedAt: at(5),
      cwd: '/work/app',
      transcriptPath: null,
      resumable: true,
    },
    expect.objectContaining({
      agentSessionId: 's-live',
      state: 'waiting',
      lastEventAt: at(3),
      endedAt: null,
    }),
    expect.objectContaining({ agentSessionId: 's-old', lastEventAt: at(2) }),
  ])
})

test('runs puts the later Run first among Runs whose last events came at the same time', async () => {
  const fixture = await withBench()
  await claudeIn(fixture, 's-first', { startedAt: 1, endedAt: 3 })
  await claudeIn(fixture, 's-second', { startedAt: 2, endedAt: 3 })

  const { runs } = await fixture.client.runs({ ref })

  expect(runs.map((r) => r.agentSessionId)).toEqual(['s-second', 's-first'])
})

test('runs lists the Runs of a closed Task with the time it was closed', async () => {
  const fixture = await withBench()
  await claudeIn(fixture, 's-1', { startedAt: 1, endedAt: 2 })
  setSystemTime(at(3))
  await fixture.client.close({ ref, force: true })

  const listed = await fixture.client.runs({ ref: 'https://github.com/acme/app/issues/12' })

  expect(listed.closedAt).toEqual(at(3))
  expect(listed.runs.map((r) => r.agentSessionId)).toEqual(['s-1'])
})

test('runs tells a Run whose transcript is gone from one that can be resumed', async () => {
  const fixture = await withBench()
  const gone = { transcript_path: transcriptOf(fixture, 's-gone', { written: false }) }
  const kept = { transcript_path: transcriptOf(fixture, 's-kept') }
  await claudeIn(fixture, 's-gone', { startedAt: 1, endedAt: 2, fields: gone })
  await claudeIn(fixture, 's-kept', { startedAt: 3, endedAt: 4, fields: kept })

  const { runs } = await fixture.client.runs({ ref })

  expect(runs.map((r) => [r.agentSessionId, r.transcriptPath, r.resumable])).toEqual([
    ['s-kept', kept.transcript_path, true],
    ['s-gone', gone.transcript_path, false],
  ])
})

test('runs refuses an Issue with no Task as not tracked', async () => {
  const fixture = setup()

  const error = await failure(fixture.client.runs({ ref }))

  expect(error).toMatchObject({ code: 'NOT_FOUND', message: `${ref} is not tracked` })
})
