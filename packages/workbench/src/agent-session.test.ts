import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { startFakePtyd } from './fake-ptyd.ts'
import { agentSession, terminalSession } from './schema.ts'
import type { Db } from './server.ts'
import { cleanUp, onCleanup, setup } from './testing.ts'

afterEach(cleanUp)

const size = { rows: 24, cols: 80 }

function payload(sessionId: string, hookEventName: string, fields: object = {}) {
  return {
    session_id: sessionId,
    transcript_path: `/transcripts/${sessionId}.jsonl`,
    cwd: '/work',
    hook_event_name: hookEventName,
    ...fields,
  }
}

function rowOf(db: Db, sessionId: string) {
  return db.select().from(agentSession).where(eq(agentSession.sessionId, sessionId)).get()
}

type Client = ReturnType<typeof setup>['client']

async function seeAsListed(client: Client, sessionId: string) {
  const listed = (await client.agentSession.list()).find((a) => a.sessionId === sessionId)
  await client.agentSession.markSeen({ sessionId, notifiedAt: listed!.notifiedAt! })
}

function seedTerminalSession(
  db: Db,
  id: string,
  status: (typeof terminalSession.$inferSelect)['status'],
) {
  db.insert(terminalSession)
    .values({ id, cwd: '/work', shell: '/bin/zsh', status, createdAt: new Date(0) })
    .run()
}

function writeTranscript(home: string, lines: string[]) {
  const path = join(home, 'transcript.jsonl')
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
  return path
}

function aiTitle(title: string) {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 's-1' })
}

function turnsOfOneKiB(count: number) {
  return Array.from({ length: count }, () =>
    JSON.stringify({ type: 'assistant', message: { content: 'あ'.repeat(330) } }),
  )
}

async function notificationsOn(
  hookEventName: string,
  fields: object,
  transcript: (home: string) => string | undefined,
) {
  const sent: object[] = []
  const { home, db, client } = setup({ notify: (n) => sent.push(n) })
  seedTerminalSession(db, 'ts-a', 'running')
  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-1', hookEventName, {
      cwd: '/Users/me/src/tania',
      transcript_path: transcript(home),
      ...fields,
    }),
  })
  return sent
}

function stderrLines() {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  onCleanup(() => spy.mockRestore())
  return () => spy.mock.calls.map((args) => args.join(' '))
}

test('a claude started in a Tab is listed idle, then follows its hooks until it leaves the list on /exit', async () => {
  const { client } = setup()
  const { tab } = await client.runspace.create(size)
  const record = (hookEventName: string, fields?: object) =>
    client.agentSession.recordHook({
      terminalSessionId: tab.terminalSessionId,
      payload: payload('s-1', hookEventName, fields),
    })

  await record('SessionStart', { source: 'startup' })
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({
      sessionId: 's-1',
      terminalSessionId: tab.terminalSessionId,
      state: 'waiting',
      waitReason: 'idle',
      cwd: '/work',
    }),
  ])

  await record('UserPromptSubmit', { prompt: 'hi' })
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ state: 'running', waitReason: null }),
  ])

  await record('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ state: 'waiting', waitReason: 'permission', waitTool: 'Bash' }),
  ])

  await record('SessionEnd', { reason: 'prompt_input_exit' })
  expect(await client.agentSession.list()).toEqual([])
})

test('the first hook of a session the Workbench Ledger does not know starts it running before applying', async () => {
  const { db, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')

  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-missed-start', 'UserPromptSubmit', { permission_mode: 'plan' }),
  })

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({
      sessionId: 's-missed-start',
      terminalSessionId: 'ts-a',
      state: 'running',
      permissionMode: 'plan',
      transcriptPath: '/transcripts/s-missed-start.jsonl',
    }),
  ])
})

test.each(['exited', 'lost', 'failed'] as const)(
  'a hook from a Terminal Session that has %s writes nothing and leaves one line on stderr',
  async (status) => {
    const { db, client } = setup()
    seedTerminalSession(db, 'ts-ended', status)
    const lines = stderrLines()

    await client.agentSession.recordHook({
      terminalSessionId: 'ts-ended',
      payload: payload('s-1', 'SessionStart', { source: 'startup' }),
    })

    expect(rowOf(db, 's-1')).toBeUndefined()
    expect(lines()).toEqual([expect.stringContaining('ts-ended')])
  },
)

test('a hook from a Terminal Session the Workbench Ledger does not know writes nothing and leaves one line on stderr', async () => {
  const { db, client } = setup()
  const lines = stderrLines()

  await client.agentSession.recordHook({
    terminalSessionId: 'ts-leaked',
    payload: payload('s-1', 'SessionStart', { source: 'startup' }),
  })

  expect(rowOf(db, 's-1')).toBeUndefined()
  expect(lines()).toEqual([expect.stringContaining('ts-leaked')])
})

test('a session starting in a Terminal Session ends the other live Agent Session there as superseded', async () => {
  const { db, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  const start = (sessionId: string) =>
    client.agentSession.recordHook({
      terminalSessionId: 'ts-a',
      payload: payload(sessionId, 'SessionStart', { source: 'startup' }),
    })

  await start('s-old')
  await start('s-new')

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-new' }),
  ])
  expect(rowOf(db, 's-old')).toMatchObject({ state: 'ended', endReason: 'superseded' })
})

test('a session resumed in another Terminal Session whose SessionStart was missed moves there with its next hook and ends the Agent Session it finds', async () => {
  const { db, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  seedTerminalSession(db, 'ts-b', 'running')
  const record = (terminalSessionId: string, sessionId: string, hookEventName: string) =>
    client.agentSession.recordHook({
      terminalSessionId,
      payload: payload(sessionId, hookEventName),
    })
  await record('ts-a', 's-moving', 'Stop')
  await record('ts-b', 's-resident', 'Stop')

  await record('ts-b', 's-moving', 'UserPromptSubmit')

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-moving', terminalSessionId: 'ts-b', state: 'running' }),
  ])
  expect(rowOf(db, 's-resident')).toMatchObject({ state: 'ended', endReason: 'superseded' })
})

test('the Workbench Ledger refuses a second live Agent Session in one Terminal Session', () => {
  const { db } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  const at = new Date(0)
  const live = (sessionId: string) => ({
    sessionId,
    terminalSessionId: 'ts-a',
    state: 'running' as const,
    cwd: '/work',
    lastEventName: 'UserPromptSubmit',
    lastEventAt: at,
    stateChangedAt: at,
    firstSeenAt: at,
  })
  db.insert(agentSession).values(live('s-1')).run()

  expect(() => db.insert(agentSession).values(live('s-2')).run()).toThrow(/UNIQUE/)
})

test('changes signals every Agent Session a hook changed', async () => {
  const { db, workbenchLedger, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-old', 'SessionStart', { source: 'startup' }),
  })
  const signals: unknown[] = []
  onCleanup(workbenchLedger.events.subscribe('change', (change) => signals.push(change)))

  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-new', 'SessionStart', { source: 'startup' }),
  })

  expect(signals).toHaveLength(2)
  expect(signals).toEqual(
    expect.arrayContaining([
      { type: 'agentSession', sessionId: 's-new' },
      { type: 'agentSession', sessionId: 's-old' },
    ]),
  )
})

test("a question asked through both of its hooks notifies once, after the commit, titled by the last two parts of the agent's cwd", async () => {
  const sent: { title: string; body: string; committed: boolean }[] = []
  const { db, client } = setup({
    notify: (n) => sent.push({ ...n, committed: !db.$client.inTransaction }),
  })
  seedTerminalSession(db, 'ts-a', 'running')
  const record = (hookEventName: string, fields?: object) =>
    client.agentSession.recordHook({
      terminalSessionId: 'ts-a',
      payload: payload('s-1', hookEventName, { cwd: '/Users/me/src/tania', ...fields }),
    })

  await record('SessionStart', { source: 'startup' })
  await record('UserPromptSubmit', { prompt: 'hi' })
  await record('PreToolUse', { tool_name: 'AskUserQuestion' })
  await record('PermissionRequest', { tool_name: 'AskUserQuestion' })

  expect(sent).toEqual([{ title: 'src/tania', body: '質問', committed: true }])
})

test.each([
  ['Stop', '手空き · Tania通知の問題', {}],
  ['PreToolUse', '質問 · Tania通知の問題', { tool_name: 'AskUserQuestion' }],
  ['PermissionRequest', '許可: Bash · Tania通知の問題', { tool_name: 'Bash' }],
  ['StopFailure', 'エラー: rate_limit · Tania通知の問題', { error: 'rate_limit' }],
  ['StopFailure', 'エラー · Tania通知の問題', {}],
])(
  'a notification on %s puts the Agent Session title from the Agent Session Transcript after the reason: %s',
  async (hookEventName, body, fields) => {
    const sent = await notificationsOn(hookEventName, fields, (home) =>
      writeTranscript(home, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '通知を直したい' } }),
        aiTitle('Tania通知の問題'),
      ]),
    )

    expect(sent).toEqual([{ title: 'src/tania', body }])
  },
)

test('the last ai-title in the Agent Session Transcript is the Agent Session title when the conversation was renamed', async () => {
  const sent = await notificationsOn('Stop', {}, (home) =>
    writeTranscript(home, [
      aiTitle('最初の名前'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '…' } }),
      aiTitle('今の名前'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '…' } }),
    ]),
  )

  expect(sent).toEqual([{ title: 'src/tania', body: '手空き · 今の名前' }])
})

test('an ai-title near the end of an Agent Session Transcript longer than 64 KiB is the Agent Session title', async () => {
  const sent = await notificationsOn('Stop', {}, (home) =>
    writeTranscript(home, [
      aiTitle('古い名前'),
      ...turnsOfOneKiB(100),
      aiTitle('今の名前'),
      ...turnsOfOneKiB(30),
    ]),
  )

  expect(sent).toEqual([{ title: 'src/tania', body: '手空き · 今の名前' }])
})

test.each([
  ['the Agent Session Transcript does not exist', (home: string) => join(home, 'gone.jsonl')],
  ['the hook gives no transcript_path', () => undefined],
  [
    'the Agent Session Transcript has no ai-title',
    (home: string) =>
      writeTranscript(home, [JSON.stringify({ type: 'user', message: { content: 'hi' } })]),
  ],
  [
    'the last ai-title line is not JSON',
    (home: string) =>
      writeTranscript(home, [aiTitle('古い名前'), '{"type":"ai-title","aiTitle":"書きかけ']),
  ],
  [
    'the last ai-title line has no aiTitle',
    (home: string) =>
      writeTranscript(home, [
        aiTitle('古い名前'),
        JSON.stringify({ type: 'ai-title', title: '別の形' }),
      ]),
  ],
])('a notification still goes out with the reason alone when %s', async (_case, transcript) => {
  const sent = await notificationsOn('Stop', {}, transcript)

  expect(sent).toEqual([{ title: 'src/tania', body: '手空き' }])
})

test('the name the Task gives an Agent Session titles its notification, and the Agent Session title stays in the body', async () => {
  const sent: object[] = []
  const { home, db, client } = setup({
    notify: (n) => sent.push(n),
    nameAgentSession: (_db, agentSessionId) =>
      agentSessionId === 's-1' ? 'tania#43 骨格 (8)' : null,
  })
  seedTerminalSession(db, 'ts-a', 'running')
  const transcriptPath = writeTranscript(home, [aiTitle('通知のTab名表示')])

  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-1', 'PermissionRequest', {
      tool_name: 'Bash',
      transcript_path: transcriptPath,
    }),
  })

  expect(sent).toEqual([{ title: 'tania#43 骨格 (8)', body: '許可: Bash · 通知のTab名表示' }])
})

test('a notification that cannot be named still leaves the hook recorded and signalled, with one line on stderr', async () => {
  const { db, workbenchLedger, client } = setup({
    nameAgentSession: () => {
      throw new Error('no such table: run')
    },
  })
  seedTerminalSession(db, 'ts-a', 'running')
  const signals: unknown[] = []
  onCleanup(workbenchLedger.events.subscribe('change', (change) => signals.push(change)))
  const lines = stderrLines()

  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-1', 'Stop'),
  })

  expect(rowOf(db, 's-1')).toMatchObject({ state: 'waiting', waitReason: 'idle' })
  expect(signals).toEqual([{ type: 'agentSession', sessionId: 's-1' }])
  expect(lines()).toEqual([expect.stringContaining('no such table: run')])
})

test('a notified wait is listed unread until it is seen, and seeing it signals the change', async () => {
  const { db, workbenchLedger, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  const record = (hookEventName: string, fields?: object) =>
    client.agentSession.recordHook({
      terminalSessionId: 'ts-a',
      payload: payload('s-1', hookEventName, fields),
    })
  await record('UserPromptSubmit', { prompt: 'hi' })
  await record('Stop')
  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
  const signals: unknown[] = []
  onCleanup(workbenchLedger.events.subscribe('change', (change) => signals.push(change)))

  await seeAsListed(client, 's-1')

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: false }),
  ])
  expect(signals).toEqual([{ type: 'agentSession', sessionId: 's-1' }])
})

test.each([
  ['a claude just started', [['SessionStart', { source: 'startup' }]], false],
  ['a turn that stopped', [['UserPromptSubmit'], ['Stop']], true],
  ['a question', [['UserPromptSubmit'], ['PreToolUse', { tool_name: 'AskUserQuestion' }]], true],
  ['a permission', [['UserPromptSubmit'], ['PermissionRequest', { tool_name: 'Bash' }]], true],
  ['an API error', [['UserPromptSubmit'], ['StopFailure', { error: 'rate_limit' }]], true],
  ['a notified wait the agent left to work again', [['Stop'], ['UserPromptSubmit']], false],
  [
    'a claude resumed after its notified wait',
    [
      ['Stop'],
      ['SessionEnd', { reason: 'prompt_input_exit' }],
      ['SessionStart', { source: 'resume' }],
    ],
    false,
  ],
] as [string, [string, object?][], boolean][])(
  '%s is listed unread: %p',
  async (_name, hooks, unread) => {
    const { db, client } = setup()
    seedTerminalSession(db, 'ts-a', 'running')

    for (const [hookEventName, fields] of hooks) {
      await client.agentSession.recordHook({
        terminalSessionId: 'ts-a',
        payload: payload('s-1', hookEventName, fields),
      })
    }

    expect(await client.agentSession.list()).toEqual([
      expect.objectContaining({ sessionId: 's-1', unread }),
    ])
  },
)

test('a second permission asked after the first was seen is unread again', async () => {
  const { db, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  const askPermission = () =>
    client.agentSession.recordHook({
      terminalSessionId: 'ts-a',
      payload: payload('s-1', 'PermissionRequest', { tool_name: 'Bash' }),
    })
  await askPermission()
  await seeAsListed(client, 's-1')

  await askPermission()

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
})

test('seeing an Agent Session with nothing unread writes nothing and signals nothing', async () => {
  const { db, workbenchLedger, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  await client.agentSession.recordHook({
    terminalSessionId: 'ts-a',
    payload: payload('s-1', 'SessionStart', { source: 'startup' }),
  })
  const signals: unknown[] = []
  onCleanup(workbenchLedger.events.subscribe('change', (change) => signals.push(change)))

  await client.agentSession.markSeen({ sessionId: 's-1', notifiedAt: new Date(0) })

  expect(rowOf(db, 's-1')).toMatchObject({ seenAt: null })
  expect(signals).toEqual([])
})

test('seeing an Agent Session the Workbench Ledger does not know is NOT_FOUND', async () => {
  const { client } = setup()

  await expect(
    client.agentSession.markSeen({ sessionId: 's-gone', notifiedAt: new Date(0) }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('seeing a notification after a later one came leaves the later one unread and signals nothing', async () => {
  const { db, workbenchLedger, client } = setup()
  seedTerminalSession(db, 'ts-a', 'running')
  onCleanup(() => setSystemTime())
  const askPermissionAt = async (ms: number) => {
    setSystemTime(new Date(ms))
    await client.agentSession.recordHook({
      terminalSessionId: 'ts-a',
      payload: payload('s-1', 'PermissionRequest', { tool_name: 'Bash' }),
    })
  }
  await askPermissionAt(1_000)
  const [shown] = await client.agentSession.list()
  await askPermissionAt(2_000)
  const signals: unknown[] = []
  onCleanup(workbenchLedger.events.subscribe('change', (change) => signals.push(change)))

  await client.agentSession.markSeen({ sessionId: 's-1', notifiedAt: shown!.notifiedAt! })

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
  expect(signals).toEqual([])
})

test('an unread wait stays unread across a Backend restart', async () => {
  const { client, restartBackend, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload('s-1', 'Stop'),
  })

  const after = restartBackend()
  await after.workbenchLedger.start()

  expect(await after.client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', unread: true }),
  ])
})

test('an Exit from ptyd ends the Agent Session in that Terminal Session', async () => {
  const { ptyd, db, client, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload('s-1', 'UserPromptSubmit', { prompt: 'hi' }),
  })

  ptyd.exit(tab.terminalSessionId, 0)
  await ptyd.received((op) => op.op === 'reap' && op.session_id === tab.terminalSessionId)

  expect(await client.agentSession.list()).toEqual([])
  expect(rowOf(db, 's-1')).toMatchObject({ state: 'ended', endReason: 'terminal_exited' })
})

test('after a Backend restart a running Agent Session is unobserved until its next hook, a waiting one stays, and one whose Terminal Session is gone has ended', async () => {
  const { ptyd, db, client, restartBackend, settled } = setup()
  const record = (terminalSessionId: string, sessionId: string, hookEventName: string) =>
    client.agentSession.recordHook({
      terminalSessionId,
      payload: payload(sessionId, hookEventName),
    })
  const busy = (await client.runspace.create(size)).tab.terminalSessionId
  const waiting = (await client.runspace.create(size)).tab.terminalSessionId
  const gone = (await client.runspace.create(size)).tab.terminalSessionId
  for (const id of [busy, waiting, gone]) await settled(id)
  await record(busy, 's-busy', 'UserPromptSubmit')
  await record(waiting, 's-waiting', 'Stop')
  await record(gone, 's-gone', 'UserPromptSubmit')
  ptyd.sessions.splice(
    ptyd.sessions.findIndex((s) => s.session_id === gone),
    1,
  )

  const after = restartBackend()
  await after.workbenchLedger.start()

  expect(await after.client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-busy', state: 'unobserved' }),
    expect.objectContaining({ sessionId: 's-waiting', state: 'waiting', waitReason: 'idle' }),
  ])
  expect(rowOf(db, 's-gone')).toMatchObject({ state: 'ended', endReason: 'terminal_exited' })

  await after.client.agentSession.recordHook({
    terminalSessionId: busy,
    payload: payload('s-busy', 'PostToolUse', { tool_name: 'Bash' }),
  })
  expect(rowOf(db, 's-busy')).toMatchObject({ state: 'running', unobservedSince: null })
})

test('reconnecting to ptyd signals each Agent Session the reconcile ends', async () => {
  const { home, ptyd, workbenchLedger, client, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload('s-1', 'UserPromptSubmit', { prompt: 'hi' }),
  })
  const signals: unknown[] = []
  const reconciled = new Promise<void>((resolve) => {
    const unsubscribe = workbenchLedger.events.subscribe('change', (change) => {
      signals.push(change)
      if (change.type !== 'reconciled') return
      unsubscribe()
      resolve()
    })
  })

  ptyd.stop()
  await Bun.sleep(50)
  const revived = startFakePtyd(home)
  onCleanup(() => revived.stop())
  await reconciled

  expect(await client.agentSession.list()).toEqual([])
  expect(signals).toContainEqual({ type: 'agentSession', sessionId: 's-1' })
})

test('reconnecting to ptyd while the Backend keeps running leaves a running Agent Session running', async () => {
  const { home, ptyd, workbenchLedger, client, settled } = setup()
  const { tab } = await client.runspace.create(size)
  await settled(tab.terminalSessionId)
  await client.agentSession.recordHook({
    terminalSessionId: tab.terminalSessionId,
    payload: payload('s-1', 'UserPromptSubmit', { prompt: 'hi' }),
  })
  const reconciled = new Promise<void>((resolve) => {
    const unsubscribe = workbenchLedger.events.subscribe('change', (change) => {
      if (change.type !== 'reconciled') return
      unsubscribe()
      resolve()
    })
  })

  ptyd.stop()
  await Bun.sleep(50)
  const revived = startFakePtyd(home)
  onCleanup(() => revived.stop())
  revived.sessions.push(...ptyd.sessions)
  await reconciled

  expect(await client.agentSession.list()).toEqual([
    expect.objectContaining({ sessionId: 's-1', state: 'running' }),
  ])
})
