import { afterEach, expect, test } from 'bun:test'

import { untilSettled } from '@monica/workbench/testing'
import { createRouterClient } from '@orpc/server'

import { cleanUp, inMemoryBackend, monica } from './testing.ts'

afterEach(cleanUp)

function backend() {
  const { router, context, ptyd } = inMemoryBackend()
  const client = createRouterClient(router, { context })
  return { client, context, ptyd, connect: () => client }
}

async function runspaceWithTwoTabs(client: ReturnType<typeof backend>['client']) {
  const { runspaceId, tab: first } = await client.workbench.runspace.create({
    cwd: '/work',
    rows: 24,
    cols: 80,
  })
  const second = await client.workbench.tab.open({ runspaceId, rows: 24, cols: 80 })
  return { runspaceId, first, second }
}

test('tab close closes the Tab it names and terminates its Terminal Session', async () => {
  const { client, ptyd, connect } = backend()
  const { first, second } = await runspaceWithTwoTabs(client)

  const result = await monica(['workbench', 'tab', 'close', first.id], connect)

  expect(result).toEqual({ code: 0, stdout: `closed Tab ${first.id}\n`, stderr: '' })
  await ptyd.received((op) => op.op === 'terminate' && op.session_id === first.terminalSessionId)
  const { runspaces } = await client.workbench.layout.get()
  expect(runspaces.flatMap((r) => r.tabs.map((t) => t.id))).toEqual([second.id])
})

test('runspace remove removes the Runspace it names with its Tabs', async () => {
  const { client, ptyd, connect } = backend()
  const { runspaceId, first, second } = await runspaceWithTwoTabs(client)

  const result = await monica(['workbench', 'runspace', 'remove', runspaceId], connect)

  expect(result).toEqual({
    code: 0,
    stdout: `removed Runspace ${runspaceId} with its Tabs\n`,
    stderr: '',
  })
  await ptyd.receivedAtLeast(
    2,
    (op) =>
      op.op === 'terminate' &&
      [first.terminalSessionId, second.terminalSessionId].includes(op.session_id),
  )
  expect((await client.workbench.layout.get()).runspaces.map((r) => r.id)).not.toContain(runspaceId)
})

test('tab close and runspace remove without an id act on the Tab of MONICA_TERMINAL_SESSION_ID and its Runspace', async () => {
  const { client, connect } = backend()
  const { runspaceId, first, second } = await runspaceWithTwoTabs(client)
  const other = await runspaceWithTwoTabs(client)

  const closed = await monica(['workbench', 'tab', 'close'], connect, {
    terminalSessionId: first.terminalSessionId,
  })
  const removed = await monica(['workbench', 'runspace', 'remove'], connect, {
    terminalSessionId: second.terminalSessionId,
  })

  expect(closed).toEqual({ code: 0, stdout: `closed Tab ${first.id}\n`, stderr: '' })
  expect(removed).toEqual({
    code: 0,
    stdout: `removed Runspace ${runspaceId} with its Tabs\n`,
    stderr: '',
  })
  expect((await client.workbench.layout.get()).runspaces.map((r) => r.id)).toEqual([
    other.runspaceId,
  ])
})

test('tab close and runspace remove without an id outside a Tab refuse with BAD_REQUEST and exit 1', async () => {
  const { connect } = backend()

  const closed = await monica(['workbench', 'tab', 'close'], connect)
  const removed = await monica(['workbench', 'runspace', 'remove'], connect, {
    terminalSessionId: 'ts-in-no-tab',
  })

  expect(closed).toEqual({
    code: 1,
    stdout: '',
    stderr: 'BAD_REQUEST: not in a Tab of the Workbench: give an id, or run this in a Tab\n',
  })
  expect(removed).toEqual({
    code: 1,
    stdout: '',
    stderr:
      'BAD_REQUEST: not in a Tab of the Workbench: Terminal Session ts-in-no-tab is in no Tab\n',
  })
})

test('tab close and runspace remove refuse an id nothing has with NOT_FOUND and exit 1', async () => {
  const { connect } = backend()

  const closed = await monica(['workbench', 'tab', 'close', 'tab-x'], connect)
  const removed = await monica(['workbench', 'runspace', 'remove', 'rs-x'], connect)

  expect(closed).toEqual({ code: 1, stdout: '', stderr: 'NOT_FOUND: no Tab tab-x\n' })
  expect(removed).toEqual({ code: 1, stdout: '', stderr: 'NOT_FOUND: no Runspace rs-x\n' })
})

test('a pinned Tab and its Runspace refuse to go with CONFLICT and exit 1', async () => {
  const { client, connect } = backend()
  const { runspaceId, tab } = await client.workbench.runspace.create({ rows: 24, cols: 80 })
  await client.workbench.tab.pin({ id: tab.id })

  const closed = await monica(['workbench', 'tab', 'close', tab.id], connect)
  const removed = await monica(['workbench', 'runspace', 'remove', runspaceId], connect)

  expect(closed).toEqual({ code: 1, stdout: '', stderr: `CONFLICT: Tab ${tab.id} is pinned\n` })
  expect(removed).toEqual({
    code: 1,
    stdout: '',
    stderr: `CONFLICT: Runspace ${runspaceId} holds a pinned Tab\n`,
  })
})

test('runspace remove refuses a Bench with CONFLICT and exit 1', async () => {
  const { client, context, connect } = backend()
  const { db, workbenchLedger } = context
  const benchId = db.transaction((tx) => {
    const id = workbenchLedger.createRunspace(tx, { cwd: '/work' })
    workbenchLedger.openTab(tx, { runspaceId: id })
    return id
  })

  const removed = await monica(['workbench', 'runspace', 'remove', benchId], connect)

  expect(removed).toEqual({
    code: 1,
    stdout: '',
    stderr: `CONFLICT: Runspace ${benchId} is owned by another domain\n`,
  })
  expect((await client.workbench.layout.get()).runspaces.map((r) => r.id)).toContain(benchId)
})

async function tabWithProcesses() {
  const { client, ptyd, connect } = backend()
  const { runspaceId, first, second } = await runspaceWithTwoTabs(client)
  const shown = await untilSettled(
    () => client.workbench.terminalSession.list(),
    first.terminalSessionId,
  )
  const shell = shown!.pid!
  ptyd.processes.set(first.terminalSessionId, [
    {
      pid: shell,
      ppid: 1,
      pgid: shell,
      state: 'Ss',
      command: '/bin/zsh --login',
      terminal_session_process: true,
    },
    {
      pid: 2001,
      ppid: shell,
      pgid: 2001,
      state: 'SN',
      command: 'python3 -m http.server 18103',
      terminal_session_process: true,
    },
    {
      pid: 2002,
      ppid: 2001,
      pgid: 2002,
      state: 'Ss',
      command: 'python3 -m http.server 18104',
      terminal_session_process: false,
    },
  ])
  const stdout = [
    `Tab ${first.id} on Terminal Session ${first.terminalSessionId}: running, shell pid ${shell}`,
    'PID   PPID  PGID  STAT  MARK   COMMAND',
    `${shell}  1     ${shell}  Ss    shell  /bin/zsh --login`,
    `2001  ${shell}  2001  SN           python3 -m http.server 18103`,
    '2002  2001  2002  Ss    stays  python3 -m http.server 18104',
    '',
  ].join('\n')
  return { client, ptyd, connect, runspaceId, first, second, shell, stdout }
}

test('tab show prints the Terminal Session, its shell pid, and its processes marking the shell and what stays', async () => {
  const { connect, first, stdout } = await tabWithProcesses()

  const result = await monica(['workbench', 'tab', 'show', first.id], connect)

  expect(result).toEqual({ code: 0, stdout, stderr: '' })
})

test('tab show without an id shows the Tab of MONICA_TERMINAL_SESSION_ID, and refuses outside a Tab with BAD_REQUEST', async () => {
  const { connect, first, stdout } = await tabWithProcesses()

  const shown = await monica(['workbench', 'tab', 'show'], connect, {
    terminalSessionId: first.terminalSessionId,
  })
  const outside = await monica(['workbench', 'tab', 'show'], connect)

  expect(shown).toEqual({ code: 0, stdout, stderr: '' })
  expect(outside).toEqual({
    code: 1,
    stdout: '',
    stderr: 'BAD_REQUEST: not in a Tab of the Workbench: give an id, or run this in a Tab\n',
  })
})

test('tab show refuses an id no Tab has with NOT_FOUND and exit 1', async () => {
  const { connect } = backend()

  const result = await monica(['workbench', 'tab', 'show', 'tab-x'], connect)

  expect(result).toEqual({ code: 1, stdout: '', stderr: 'NOT_FOUND: no Tab tab-x\n' })
})

test('tab show says it could not list the processes when monica-ptyd is out of reach', async () => {
  const { client, ptyd, connect, first, shell } = await tabWithProcesses()
  ptyd.stop()

  const result = await monica(['workbench', 'tab', 'show', first.id], connect)
  const json = await client.workbench.tab.show({ id: first.id })

  expect(result).toEqual({
    code: 0,
    stdout:
      `Tab ${first.id} on Terminal Session ${first.terminalSessionId}: running, shell pid ${shell}\n` +
      'could not list the processes from monica-ptyd\n',
    stderr: '',
  })
  expect(json.processes).toBeNull()
})

test('tab show --format json prints the procedure output as it is', async () => {
  const { connect, first, shell } = await tabWithProcesses()

  const result = await monica(['workbench', 'tab', 'show', first.id, '--format', 'json'], connect)

  const shown = JSON.parse(result.stdout)
  expect(shown.tab.id).toBe(first.id)
  expect(shown.terminalSession).toMatchObject({
    id: first.terminalSessionId,
    status: 'running',
    pid: shell,
  })
  expect(shown.processes).toEqual([
    {
      pid: shell,
      ppid: 1,
      pgid: shell,
      state: 'Ss',
      command: '/bin/zsh --login',
      terminalSessionProcess: true,
    },
    {
      pid: 2001,
      ppid: shell,
      pgid: 2001,
      state: 'SN',
      command: 'python3 -m http.server 18103',
      terminalSessionProcess: true,
    },
    {
      pid: 2002,
      ppid: 2001,
      pgid: 2002,
      state: 'Ss',
      command: 'python3 -m http.server 18104',
      terminalSessionProcess: false,
    },
  ])
})

async function secondShell(
  client: ReturnType<typeof backend>['client'],
  terminalSessionId: string,
) {
  return (await untilSettled(() => client.workbench.terminalSession.list(), terminalSessionId))!
    .pid!
}

test('runspace show prints the Runspace and each Tab like tab show, in the order of its Tabs', async () => {
  const { client, connect, runspaceId, second, stdout } = await tabWithProcesses()
  const otherShell = await secondShell(client, second.terminalSessionId)

  const result = await monica(['workbench', 'runspace', 'show', runspaceId], connect)

  expect(result).toEqual({
    code: 0,
    stdout:
      `Runspace ${runspaceId} at /work\n\n${stdout}\n` +
      `Tab ${second.id} on Terminal Session ${second.terminalSessionId}: running, shell pid ${otherShell}\n` +
      'No processes\n',
    stderr: '',
  })
})

test('runspace show without an id shows the Runspace of MONICA_TERMINAL_SESSION_ID, and refuses outside a Tab with BAD_REQUEST', async () => {
  const { client, connect, runspaceId, second } = await tabWithProcesses()
  await runspaceWithTwoTabs(client)

  const shown = await monica(['workbench', 'runspace', 'show', '--format', 'json'], connect, {
    terminalSessionId: second.terminalSessionId,
  })
  const outside = await monica(['workbench', 'runspace', 'show'], connect)

  expect(JSON.parse(shown.stdout).runspace.id).toBe(runspaceId)
  expect(outside).toEqual({
    code: 1,
    stdout: '',
    stderr: 'BAD_REQUEST: not in a Tab of the Workbench: give an id, or run this in a Tab\n',
  })
})

test('runspace show refuses an id no Runspace has with NOT_FOUND and exit 1', async () => {
  const { connect } = backend()

  const result = await monica(['workbench', 'runspace', 'show', 'rs-x'], connect)

  expect(result).toEqual({ code: 1, stdout: '', stderr: 'NOT_FOUND: no Runspace rs-x\n' })
})

test('runspace show says, for each Tab, it could not list the processes when monica-ptyd is out of reach', async () => {
  const { client, ptyd, connect, runspaceId, first, second, shell } = await tabWithProcesses()
  const otherShell = await secondShell(client, second.terminalSessionId)
  ptyd.stop()

  const result = await monica(['workbench', 'runspace', 'show', runspaceId], connect)

  expect(result).toEqual({
    code: 0,
    stdout:
      `Runspace ${runspaceId} at /work\n\n` +
      `Tab ${first.id} on Terminal Session ${first.terminalSessionId}: running, shell pid ${shell}\n` +
      'could not list the processes from monica-ptyd\n\n' +
      `Tab ${second.id} on Terminal Session ${second.terminalSessionId}: running, shell pid ${otherShell}\n` +
      'could not list the processes from monica-ptyd\n',
    stderr: '',
  })
})

test('runspace show --format json prints the procedure output as it is', async () => {
  const { connect, runspaceId, first, second } = await tabWithProcesses()

  const result = await monica(
    ['workbench', 'runspace', 'show', runspaceId, '--format', 'json'],
    connect,
  )

  const shown = JSON.parse(result.stdout)
  expect(shown.runspace).toMatchObject({ id: runspaceId, cwd: '/work' })
  expect(shown.tabs.map((t: { tab: { id: string } }) => t.tab.id)).toEqual([first.id, second.id])
  expect(shown.tabs[0].processes.map((p: { pid: number }) => p.pid)).toContain(2002)
  expect(shown.tabs[1].processes).toEqual([])
})

test('tab close and runspace remove --format json print the procedure output as it is', async () => {
  const { client, connect } = backend()
  const { runspaceId, first } = await runspaceWithTwoTabs(client)

  const closed = await monica(['workbench', 'tab', 'close', first.id, '--format', 'json'], connect)
  const removed = await monica(
    ['workbench', 'runspace', 'remove', runspaceId, '--format', 'json'],
    connect,
  )

  expect(JSON.parse(closed.stdout)).toEqual({ tabId: first.id, emptiedRunspaceId: null })
  expect(JSON.parse(removed.stdout)).toEqual({ runspaceId })
})
