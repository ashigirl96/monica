import { afterEach, beforeEach, expect, test } from 'bun:test'

import { createStore, type Store } from 'jotai'

import { cleanUp, setup } from '../testing.ts'
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  pickTileAtom,
  selectedTileAtom,
} from './navigation.ts'
import {
  reloadAtom,
  toggleSectionAtom,
  type WorkbenchClient,
  workbenchClientAtom,
} from './store.ts'
import { type BenchLabel, type BenchLabelOf, benchLabelOfAtom, OUTSIDE } from './tile-assignment.ts'
import { persistUiState } from './ui-state-persistence.ts'
import {
  collapsedSectionsAtom,
  setUiZoomAtom,
  sidebarOpenAtom,
  sidebarWidthAtom,
  uiZoomAtom,
} from './ui-state.ts'

const size = { rows: 24, cols: 80 }

// Bun には localStorage が無いので、webview の代わりに memory に置く。
let stored = new Map<string, string>()
let onWrite = () => {}

function useStorage(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  globalThis.localStorage = storage as Storage
}

beforeEach(() => {
  stored = new Map()
  onWrite = () => {}
  useStorage({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value)
      onWrite()
    },
  })
})

afterEach(() => {
  cleanUp()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

// Bench は Task の Repo の Tile に並ぶので、git の checkout が無くても Repo の Tile ができる。
function benchesIn(repo: string, ...runspaceIds: string[]): BenchLabelOf {
  const labels = Object.fromEntries(
    runspaceIds.map((id, i): [string, BenchLabel] => [
      id,
      { repo, number: i + 1, title: `Issue ${i + 1}`, setup: null },
    ]),
  )
  return (runspaceId) => labels[runspaceId] ?? null
}

function workbenchStore(client: WorkbenchClient, benchLabelOf: BenchLabelOf = () => null): Store {
  const store = createStore()
  store.set(workbenchClientAtom, () => client)
  store.set(benchLabelOfAtom, () => benchLabelOf)
  return store
}

async function saveFrom(
  client: WorkbenchClient,
  change: (store: Store) => void,
  benchLabelOf?: BenchLabelOf,
) {
  const store = workbenchStore(client, benchLabelOf)
  const stop = persistUiState(store)
  await store.set(reloadAtom)
  const written = new Promise<void>((resolve) => (onWrite = resolve))
  change(store)
  await written
  stop()
}

async function storeAfterRestart(client: WorkbenchClient, benchLabelOf?: BenchLabelOf) {
  const store = workbenchStore(client, benchLabelOf)
  await store.set(reloadAtom)
  return store
}

async function restart(client: WorkbenchClient) {
  const store = await storeAfterRestart(client)
  return {
    runspaceId: store.get(activeRunspaceAtom)?.id,
    tabId: store.get(activeTerminalTabAtom)?.id,
    sidebarOpen: store.get(sidebarOpenAtom),
    sidebarWidth: store.get(sidebarWidthAtom),
    uiZoom: store.get(uiZoomAtom),
  }
}

const defaults = { sidebarOpen: true, sidebarWidth: 200, uiZoom: 1 }

function benchRunspace({ db, workbenchLedger }: ReturnType<typeof setup>) {
  return db.transaction((tx) => workbenchLedger.createRunspace(tx, { cwd: '/work' }))
}

test('the active Runspace and Tab, the Tile kept, the collapsed sections, the sidebar, and the UI zoom come back after a restart', async () => {
  const backend = setup()
  const { client } = backend
  const shipIt = benchRunspace(backend)
  const fixIt = benchRunspace(backend)
  await client.tab.open({ runspaceId: shipIt, ...size })
  await client.tab.open({ runspaceId: fixIt, ...size })
  const tab = await client.tab.open({ runspaceId: fixIt, ...size })
  const benchLabelOf = benchesIn('acme/app', shipIt, fixIt)

  await saveFrom(
    client,
    (store) => {
      store.set(activateRunspaceAtom, fixIt)
      store.set(activateTerminalTabAtom, tab.id)
      store.set(pickTileAtom, OUTSIDE)
      store.set(toggleSectionAtom, 'acme/app:bench')
      store.set(sidebarOpenAtom, false)
      store.set(sidebarWidthAtom, 280)
      store.set(setUiZoomAtom, 'in')
    },
    benchLabelOf,
  )

  const store = await storeAfterRestart(client, benchLabelOf)
  expect({
    runspaceId: store.get(activeRunspaceAtom)?.id,
    tabId: store.get(activeTerminalTabAtom)?.id,
    tile: store.get(selectedTileAtom),
    collapsed: [...store.get(collapsedSectionsAtom)],
    sidebarOpen: store.get(sidebarOpenAtom),
    sidebarWidth: store.get(sidebarWidthAtom),
    uiZoom: store.get(uiZoomAtom),
  }).toEqual({
    runspaceId: fixIt,
    tabId: tab.id,
    tile: OUTSIDE,
    collapsed: ['acme/app:bench'],
    sidebarOpen: false,
    sidebarWidth: 280,
    uiZoom: 1.1,
  })
})

test('a Tile kept while a Pinned Runspace was active does not come back after a restart once that Runspace is no longer Pinned', async () => {
  const backend = setup()
  const { client } = backend
  const shipIt = benchRunspace(backend)
  await client.tab.open({ runspaceId: shipIt, ...size })
  const pinned = await client.runspace.create({ cwd: '/work', ...size })
  await client.tab.pin({ id: pinned.tab.id })
  const benchLabelOf = benchesIn('acme/app', shipIt)
  await saveFrom(
    client,
    (store) => {
      store.set(activateRunspaceAtom, shipIt)
      store.set(activateRunspaceAtom, pinned.runspaceId)
    },
    benchLabelOf,
  )
  expect(JSON.parse([...stored.values()][0]!).tile).toBe('acme/app')

  await client.tab.unpin({ id: pinned.tab.id })

  expect((await storeAfterRestart(client, benchLabelOf)).get(selectedTileAtom)).toBe(OUTSIDE)
})

test('the Tile kept is saved as tile, and one saved as rail is not read, leaving the Tile to follow the active Runspace', async () => {
  const backend = setup()
  const { client } = backend
  const shipIt = benchRunspace(backend)
  await client.tab.open({ runspaceId: shipIt, ...size })
  const benchLabelOf = benchesIn('acme/app', shipIt)
  await saveFrom(client, (store) => store.set(pickTileAtom, OUTSIDE), benchLabelOf)
  const key = [...stored.keys()][0]!
  const { tile: saved, ...rest } = JSON.parse(stored.get(key)!)
  expect(saved).toBe(OUTSIDE)
  stored.set(key, JSON.stringify({ ...rest, rail: OUTSIDE }))

  expect((await storeAfterRestart(client, benchLabelOf)).get(selectedTileAtom)).toBe('acme/app')
})

test('a change made just before the page goes away is saved without waiting for the debounce', async () => {
  const { client } = setup()
  await client.runspace.create(size)
  const store = workbenchStore(client)
  const stop = persistUiState(store)
  await store.set(reloadAtom)

  store.set(sidebarWidthAtom, 300)
  dispatchEvent(new Event('pagehide'))

  expect(await restart(client)).toMatchObject({ sidebarWidth: 300 })
  stop()
})

test('a saved UI state that is corrupted starts from the defaults', async () => {
  const { client } = setup()
  const first = await client.runspace.create(size)
  const second = await client.runspace.create(size)
  await saveFrom(client, (store) => {
    store.set(activateRunspaceAtom, second.runspaceId)
    store.set(sidebarWidthAtom, 280)
  })

  for (const corrupted of ['{', 'null', '[]', '"text"']) {
    for (const key of stored.keys()) stored.set(key, corrupted)
    expect(await restart(client)).toEqual({
      runspaceId: first.runspaceId,
      tabId: first.tab.id,
      ...defaults,
    })
  }
})

test('a localStorage that is empty or cannot be read starts from the defaults', async () => {
  const { client } = setup()
  await client.runspace.create(size)

  expect(await restart(client)).toMatchObject(defaults)

  useStorage({
    getItem: () => {
      throw new DOMException('denied', 'SecurityError')
    },
    setItem: () => {},
  })
  expect(await restart(client)).toMatchObject(defaults)
})
