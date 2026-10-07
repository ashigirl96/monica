import { afterEach, expect, mock, test } from 'bun:test'

// Shell は Tauri の外に無いので、持っているクリックと張られた listener をここで持つ。
let heldClick: string | null = null
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string) => {
    if (command !== 'take_notification_click') return
    const taken = heldClick
    heldClick = null
    return taken
  },
}))
const listeners = new Map<string, () => void>()
const tauriEvent = await import('@tauri-apps/api/event')
await mock.module('@tauri-apps/api/event', () => ({
  ...tauriEvent,
  listen: async (event: string, handler: () => void) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}))

const { createStore } = await import('jotai')
const { cleanUp, onCleanup, setup, until } = await import('../testing.ts')
const { activeTerminalTabAtom, reloadAtom, workbenchClientAtom } = await import('./store.ts')
const { followNotificationClicks } = await import('./notification-click.ts')

const size = { rows: 24, cols: 80 }

// Shell の持ち物は atom の外にあるので、store の購読では待てない。
async function untilTrue(done: () => boolean) {
  while (!done()) await Bun.sleep(1)
}

afterEach(() => {
  cleanUp()
  heldClick = null
  listeners.clear()
})

async function bench() {
  const backend = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => backend.client)
  const { runspaceId } = await backend.client.runspace.create(size)
  const waiting = await backend.client.tab.open({ runspaceId, ...size })
  return { ...backend, store, runspaceId, waiting }
}

test('a click the Shell held before the webview reached the Backend brings up its Tab once the layout is read', async () => {
  const { client, store, waiting } = await bench()
  store.set(workbenchClientAtom, null)
  heldClick = waiting.terminalSessionId

  onCleanup(followNotificationClicks(store))
  await untilTrue(() => heldClick === null)
  store.set(workbenchClientAtom, () => client)
  await store.set(reloadAtom)

  const shown = await until(store, activeTerminalTabAtom, (tab) => tab?.id === waiting.id)
  expect(shown?.id).toBe(waiting.id)
})

test('a click on a Tab opened since the layout was last read brings up that Tab', async () => {
  const { client, store, runspaceId } = await bench()
  await store.set(reloadAtom)
  const opened = await client.tab.open({ runspaceId, ...size })
  onCleanup(followNotificationClicks(store))
  await untilTrue(() => listeners.has('notification-clicked'))

  heldClick = opened.terminalSessionId
  listeners.get('notification-clicked')?.()

  const shown = await until(store, activeTerminalTabAtom, (tab) => tab?.id === opened.id)
  expect(shown?.id).toBe(opened.id)
})

test('a click heard while listening is taken from the Shell and brings up its Tab', async () => {
  const { store, waiting } = await bench()
  await store.set(reloadAtom)
  onCleanup(followNotificationClicks(store))
  await untilTrue(() => listeners.has('notification-clicked'))

  heldClick = waiting.terminalSessionId
  listeners.get('notification-clicked')?.()

  const shown = await until(store, activeTerminalTabAtom, (tab) => tab?.id === waiting.id)
  expect(shown?.id).toBe(waiting.id)
})

// 取り出したクリックは Shell から消えるので、dev の StrictMode が effect を張り直しても捨てられない。
test('a click taken after its effect was cleaned up still brings up its Tab', async () => {
  const { store, waiting } = await bench()
  await store.set(reloadAtom)
  heldClick = waiting.terminalSessionId

  followNotificationClicks(store)()

  const shown = await until(store, activeTerminalTabAtom, (tab) => tab?.id === waiting.id)
  expect(shown?.id).toBe(waiting.id)
})
