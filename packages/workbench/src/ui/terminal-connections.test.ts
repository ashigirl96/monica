import { afterEach, expect, spyOn, test } from 'bun:test'

import { createStore, type Store } from 'jotai'

import { cleanUp, onCleanup, setup, until } from '../testing.ts'
import { connectAsPane, fakeTerminalPort, mountFakeTerminal } from './fake-terminal-port.ts'
import { reloadAtom, workbenchClientAtom } from './store.ts'
import { releaseTabsLeavingLayout, tabConnectionsAtom } from './terminal-connections.ts'
import { type TerminalSessionStatus, terminalSessionStatusAtom } from './terminal-sessions.ts'

const size = { rows: 24, cols: 80 }

afterEach(() => {
  cleanUp()
})

function untilStatus(store: Store, sessionId: string, status: TerminalSessionStatus) {
  return until(store, terminalSessionStatusAtom, (s) => s[sessionId]?.status === status)
}

async function connected(store: Store, tabId: string, sessionId: string) {
  connectAsPane(store, tabId, sessionId)
  await untilStatus(store, sessionId, 'running')
}

test('a connection released while it subscribes never attaches and leaves no listener', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  mountFakeTerminal(store, 'tab-1')
  const subscribing = shell.hold('onOutput')

  connectAsPane(store, 'tab-1', 'ts-1')
  await subscribing.reached
  store.get(tabConnectionsAtom).release('tab-1')
  subscribing.release()
  // 接続が attach まで進むなら、後から繋いだ Tab の attach より先に届く。
  await connected(store, 'tab-2', 'ts-2')

  expect(shell.calls).toEqual([{ command: 'attach', sessionId: 'ts-2' }])
  expect(shell.listening()).toEqual(['output:ts-2', 'exit:ts-2'])
})

test('a connection released while it attaches writes nothing into the pane and leaves no listener', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  const { written } = mountFakeTerminal(store, 'tab-1')
  shell.replays.set('ts-1', 'replay')
  const attaching = shell.hold('attach')

  connectAsPane(store, 'tab-1', 'ts-1')
  await attaching.reached
  store.get(tabConnectionsAtom).release('tab-1')
  attaching.release()
  await connected(store, 'tab-2', 'ts-2')

  expect(written).toEqual([])
  expect(shell.listening()).toEqual(['output:ts-2', 'exit:ts-2'])
  expect(store.get(terminalSessionStatusAtom)['ts-1']).toBeUndefined()
})

test('a Tab connects once however often its pane asks, in each store on its own', async () => {
  const store = createStore()
  const other = createStore()
  const shell = fakeTerminalPort(store)
  const otherShell = fakeTerminalPort(other)
  mountFakeTerminal(store, 'tab-1')
  mountFakeTerminal(other, 'tab-1')

  connectAsPane(store, 'tab-1', 'ts-1')
  await connected(store, 'tab-1', 'ts-1')
  await connected(other, 'tab-1', 'ts-1')

  expect(shell.calls).toEqual([{ command: 'attach', sessionId: 'ts-1' }])
  expect(otherShell.calls).toEqual([{ command: 'attach', sessionId: 'ts-1' }])
})

test('output that arrives before the replay is written after it, and replies during the replay do not reach the shell', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  const { written, parsed } = mountFakeTerminal(store, 'tab-1')
  shell.replays.set('ts-1', 'replay')
  const attaching = shell.hold('attach')

  connectAsPane(store, 'tab-1', 'ts-1')
  await attaching.reached
  shell.output('ts-1', 'live')
  attaching.release()
  await untilStatus(store, 'ts-1', 'running')

  expect(written).toEqual(['replay', 'live'])
  const connections = store.get(tabConnectionsAtom)
  connections.reply('tab-1', 'during-replay')
  for (const done of parsed) done()
  connections.reply('tab-1', 'after-replay')
  // 書き込みは送った順に届くので、後の返答が届いた時点で、先の返答が送られていれば先に並んでいる。
  await shell.received(2)
  expect(shell.calls).toEqual([
    { command: 'attach', sessionId: 'ts-1' },
    { command: 'write', sessionId: 'ts-1', data: 'after-replay' },
  ])
})

test('a pane unmounted before its replay is parsed lets the next pane reply to the shell', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  const { unmount } = mountFakeTerminal(store, 'tab-1')
  shell.replays.set('ts-1', 'replay')
  await connected(store, 'tab-1', 'ts-1')

  unmount()
  mountFakeTerminal(store, 'tab-1')
  const connections = store.get(tabConnectionsAtom)
  connections.reply('tab-1', 'answer')
  // 入力は replay に関わらず送るので、届いた時点で返答が送られていれば先に並んでいる。
  connections.input('tab-1', 'typed')
  await shell.received(2)

  expect(shell.calls[1]).toEqual({ command: 'write', sessionId: 'ts-1', data: 'answer' })
})

test('a connection whose attach fails is lost, never reconnects, and drops input', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  mountFakeTerminal(store, 'tab-1')
  shell.hold('attach').fail(new Error('no such session'))
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  onCleanup(() => warn.mockRestore())

  connectAsPane(store, 'tab-1', 'ts-1')
  await untilStatus(store, 'ts-1', 'lost')
  connectAsPane(store, 'tab-1', 'ts-1')
  store.get(tabConnectionsAtom).input('tab-1', 'ls\r')
  // 再び attach を頼むか入力を送るなら、後から繋いだ Tab の attach より先に届く。
  await connected(store, 'tab-2', 'ts-2')

  expect(shell.calls).toEqual([{ command: 'attach', sessionId: 'ts-2' }])
  expect(shell.listening()).toEqual(['output:ts-2', 'exit:ts-2'])
})

test('a Tab that leaves the layout without the webview closing it releases its connection and listeners', async () => {
  const { client, settled } = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => client)
  const shell = fakeTerminalPort(store)
  const { runspaceId } = await client.runspace.create(size)
  const tab = await client.tab.open({ runspaceId, ...size })
  await settled(tab.terminalSessionId)
  await store.set(reloadAtom)
  onCleanup(releaseTabsLeavingLayout(store))
  const { written } = mountFakeTerminal(store, tab.id)
  connectAsPane(store, tab.id, tab.terminalSessionId)
  // 読み直しで status はもう running なので、attach が届くのを待つ。
  await shell.received(1)
  expect(shell.listening()).toContain(`exit:${tab.terminalSessionId}`)

  await client.tab.close({ id: tab.id })
  await store.set(reloadAtom)
  shell.output(tab.terminalSessionId, 'after close')

  expect(store.get(tabConnectionsAtom).tabIds()).toEqual([])
  expect(shell.listening()).toEqual([])
  expect(written).toEqual([])
})

test('writes to a Terminal Session reach it in the order they were made', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  mountFakeTerminal(store, 'tab-1')
  await connected(store, 'tab-1', 'ts-1')
  const slow = shell.hold('write')

  const connections = store.get(tabConnectionsAtom)
  connections.input('tab-1', 'slow')
  connections.input('tab-1', 'fast')
  await slow.reached
  await Bun.sleep(5)
  slow.release()
  await shell.received(3)

  expect(shell.calls.slice(1)).toEqual([
    { command: 'write', sessionId: 'ts-1', data: 'slow' },
    { command: 'write', sessionId: 'ts-1', data: 'fast' },
  ])
})

test('resizes of a Terminal Session reach it in the order they were made', async () => {
  const store = createStore()
  const shell = fakeTerminalPort(store)
  const { term } = mountFakeTerminal(store, 'tab-1')
  await connected(store, 'tab-1', 'ts-1')
  const slow = shell.hold('resize')

  const connections = store.get(tabConnectionsAtom)
  term.rows = 10
  connections.resize('tab-1')
  term.rows = 30
  connections.resize('tab-1')
  await slow.reached
  await Bun.sleep(5)
  slow.release()
  await shell.received(3)

  expect(shell.calls.slice(1)).toEqual([
    { command: 'resize', sessionId: 'ts-1', rows: 10, cols: 80 },
    { command: 'resize', sessionId: 'ts-1', rows: 30, cols: 80 },
  ])
})
