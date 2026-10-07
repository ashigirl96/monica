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
  return { ...backend, store, waiting }
}

test('a click the Shell held before the webview listened brings up its Tab once the layout is read', async () => {
  const { store, waiting } = await bench()
  heldClick = waiting.terminalSessionId

  onCleanup(followNotificationClicks(store))
  await untilTrue(() => heldClick === null)
  await store.set(reloadAtom)

  expect(store.get(activeTerminalTabAtom)?.id).toBe(waiting.id)
})

test('a click heard while listening is taken from the Shell and brings up its Tab', async () => {
  const { store, waiting } = await bench()
  await store.set(reloadAtom)
  onCleanup(followNotificationClicks(store))
  await untilTrue(() => listeners.has('notification-clicked'))

  heldClick = waiting.terminalSessionId
  listeners.get('notification-clicked')?.()

  await until(store, activeTerminalTabAtom, (tab) => tab?.id === waiting.id)
  expect(heldClick).toBeNull()
})
