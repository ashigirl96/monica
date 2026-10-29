import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import type { Terminal } from '@xterm/xterm'
import type { Store } from 'jotai'

import type { TerminalSessionStatus } from './terminal-sessions.ts'
import type { AttachResult } from './terminal.ts'

// Shell は Tauri の外に無いので、attach の答えを差し替え、書き込みを記録する。
let attach: (sessionId: string) => Promise<AttachResult> = async () => ({
  replay: '',
  rows: 24,
  cols: 80,
})
const shellCalls: { command: string; args: Record<string, unknown> }[] = []
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string, args: Record<string, unknown>) => {
    shellCalls.push({ command, args })
    if (command === 'terminal_renderer_register') return { renderer: 1, connection: 1 }
    return command === 'terminal_attach' ? attach(args.sessionId as string) : undefined
  },
}))
// listener は event の名前で持ち、張り終えるのを止められるようにする。
let subscribed: Promise<void> = Promise.resolve()
const listeners = new Map<string, (event: { payload: unknown }) => void>()
const tauriEvent = await import('@tauri-apps/api/event')
await mock.module('@tauri-apps/api/event', () => ({
  ...tauriEvent,
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    await subscribed
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}))

const { createStore } = await import('jotai')
const { cleanUp, onCleanup, setup, until } = await import('../testing.ts')
const { encoder, toBase64 } = await import('./base64.ts')
const { reloadAtom, workbenchClientAtom } = await import('./store.ts')
const {
  connectTab,
  clearTabTerminal,
  heartbeatRenderer,
  getTabConnection,
  releaseTabConnection,
  releaseTabsLeavingLayout,
  replyToShell,
  setTabTerminal,
} = await import('./terminal-connections.ts')
const { terminalSessionStatusAtom } = await import('./terminal-sessions.ts')

const size = { rows: 24, cols: 80 }
const decoder = new TextDecoder()

afterEach(() => {
  cleanUp()
  attach = async () => ({ replay: '', ...size })
  subscribed = Promise.resolve()
  shellCalls.length = 0
  listeners.clear()
})

// xterm は DOM が要るので、書き込みを記録して replay の parse の終わりを手で知らせる object で代える。
function fakeTerminal(tabId: string) {
  const written: string[] = []
  const parsed: (() => void)[] = []
  const grids: number[][] = []
  const term = {
    resize(cols: number, rows: number) {
      grids.push([rows, cols])
    },
    write(data: Uint8Array, callback?: () => void) {
      written.push(decoder.decode(data))
      if (callback) parsed.push(callback)
    },
  }
  setTabTerminal(tabId, term as unknown as Terminal)
  onCleanup(() => releaseTabConnection(tabId))
  return { written, parsed, grids, term: term as unknown as Terminal }
}

function b64(text: string) {
  return toBase64(encoder.encode(text))
}

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({ payload })
}

function untilStatus(store: Store, sessionId: string, status: TerminalSessionStatus) {
  return until(store, terminalSessionStatusAtom, (s) => s[sessionId]?.status === status)
}

// Shell の command は atom の外にあるので、store の購読では待てない。
async function untilTrue(done: () => boolean) {
  while (!done()) await Bun.sleep(1)
}

function commands() {
  return shellCalls.map((call) => call.command)
}

test('a connection released while it subscribes never attaches and leaves no listener', async () => {
  const store = createStore()
  fakeTerminal('tab-1')
  const { promise, resolve } = Promise.withResolvers<void>()
  subscribed = promise

  connectTab(store, { tabId: 'tab-1', sessionId: 'ts-1', onExit: () => {} })
  const connecting = getTabConnection('tab-1')?.inFlight
  releaseTabConnection('tab-1')
  resolve()
  await connecting

  expect(commands()).not.toContain('terminal_attach')
  expect([...listeners.keys()]).toEqual([])
})

test('output that arrives before the replay is written after it, and replies during the replay do not reach the shell', async () => {
  const store = createStore()
  const { written, parsed } = fakeTerminal('tab-1')
  const attached = Promise.withResolvers<AttachResult>()
  attach = () => attached.promise

  connectTab(store, { tabId: 'tab-1', sessionId: 'ts-1', onExit: () => {} })
  await untilTrue(() => commands().includes('terminal_attach'))
  emit('terminal:output:ts-1', {
    data: b64('live'),
    progress: { generation: { renderer: 1, connection: 1 }, sequence: 1 },
  })
  attached.resolve({ replay: b64('replay'), ...size })
  await untilStatus(store, 'ts-1', 'running')

  expect(written).toEqual(['replay', 'live'])
  replyToShell('tab-1', 'during-replay')
  for (const done of parsed) done()
  replyToShell('tab-1', 'after-replay')
  // 書き込みは送った順に届くので、後の返答が届いた時点で、先の返答が送られていれば先に並んでいる。
  await untilTrue(() => commands().includes('terminal_write'))
  expect(shellCalls.filter((call) => call.command === 'terminal_write')).toEqual([
    { command: 'terminal_write', args: { sessionId: 'ts-1', data: b64('after-replay') } },
  ])
})

test('a connection whose attach fails is lost and never reconnects', async () => {
  const store = createStore()
  fakeTerminal('tab-1')
  attach = async () => {
    throw new Error('no such session')
  }
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  onCleanup(() => warn.mockRestore())

  connectTab(store, { tabId: 'tab-1', sessionId: 'ts-1', onExit: () => {} })
  await untilStatus(store, 'ts-1', 'lost')
  connectTab(store, {
    tabId: 'tab-1',
    sessionId: 'ts-1',
    status: store.get(terminalSessionStatusAtom)['ts-1']?.status,
    onExit: () => {},
  })

  expect(getTabConnection('tab-1')?.inFlight).toBeUndefined()
  expect(commands().filter((command) => command === 'terminal_attach')).toHaveLength(1)
  expect([...listeners.keys()]).toEqual([])
})

test('a Tab that leaves the layout without the webview closing it releases its connection and listeners', async () => {
  const { client, settled } = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => client)
  const { runspaceId } = await client.runspace.create(size)
  const tab = await client.tab.open({ runspaceId, ...size })
  await settled(tab.terminalSessionId)
  await store.set(reloadAtom)
  onCleanup(releaseTabsLeavingLayout(store))
  fakeTerminal(tab.id)
  connectTab(store, { tabId: tab.id, sessionId: tab.terminalSessionId, onExit: () => {} })
  // 読み直しで status はもう running なので、接続が attach し終えるのを待つ。
  await untilTrue(() => getTabConnection(tab.id)?.state === 'attached')
  expect(listeners.has(`terminal:exit:${tab.terminalSessionId}`)).toBe(true)

  await client.tab.close({ id: tab.id })
  await store.set(reloadAtom)

  expect(getTabConnection(tab.id)).toBeUndefined()
  expect([...listeners.keys()]).toEqual([])
})

test('hidden preparation preserves the attached grid and waits for replay parsing without reattaching a healthy renderer', async () => {
  const store = createStore()
  const { term, parsed, grids } = fakeTerminal('hidden')
  attach = async () => ({ replay: b64('retained'), rows: 31, cols: 97 })
  const tab = { tabId: 'hidden', sessionId: 'hidden-session', hidden: true, onExit() {} }
  connectTab(store, tab)
  await untilTrue(() => getTabConnection('hidden')?.state === 'attached')
  heartbeatRenderer('hidden')
  expect(commands()).not.toContain('terminal_renderer_parsed')
  expect(grids).toEqual([[31, 97]])
  expect(commands()).not.toContain('terminal_resize')
  parsed[0]!()
  await untilTrue(() => commands().includes('terminal_renderer_parsed'))
  connectTab(store, tab)
  expect(commands().filter((command) => command === 'terminal_attach')).toHaveLength(1)
  clearTabTerminal('hidden', term)
  const sent = shellCalls.filter((call) => call.command === 'terminal_renderer_parsed').length
  parsed[0]!()
  heartbeatRenderer('hidden')
  expect(shellCalls.filter((call) => call.command === 'terminal_renderer_parsed')).toHaveLength(
    sent,
  )
  expect(commands()).toContain('terminal_renderer_remove')
})
