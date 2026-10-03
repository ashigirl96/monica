import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore, type Store } from "jotai";
import { cleanUp, setup } from "../testing.ts";
import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  reloadAtom,
  type WorkbenchClient,
  workbenchClientAtom,
} from "./store.ts";
import { setUiZoomAtom, sidebarOpenAtom, sidebarWidthAtom, uiZoomAtom } from "./ui-state.ts";
import { persistUiState } from "./ui-state-persistence.ts";

const size = { rows: 24, cols: 80 };

// Bun には localStorage が無いので、webview の代わりに memory に置く。
let stored = new Map<string, string>();
let onWrite = () => {};

function useStorage(storage: Pick<Storage, "getItem" | "setItem">) {
  globalThis.localStorage = storage as Storage;
}

beforeEach(() => {
  stored = new Map();
  onWrite = () => {};
  useStorage({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
      onWrite();
    },
  });
});

afterEach(() => {
  cleanUp();
  Reflect.deleteProperty(globalThis, "localStorage");
});

function workbenchStore(client: WorkbenchClient): Store {
  const store = createStore();
  store.set(workbenchClientAtom, () => client);
  return store;
}

async function saveFrom(client: WorkbenchClient, change: (store: Store) => void) {
  const store = workbenchStore(client);
  const stop = persistUiState(store);
  await store.set(reloadAtom);
  const written = new Promise<void>((resolve) => (onWrite = resolve));
  change(store);
  await written;
  stop();
}

async function restart(client: WorkbenchClient) {
  const store = workbenchStore(client);
  await store.set(reloadAtom);
  return {
    runspaceId: store.get(activeRunspaceAtom)?.id,
    tabId: store.get(activeTerminalTabAtom)?.id,
    sidebarOpen: store.get(sidebarOpenAtom),
    sidebarWidth: store.get(sidebarWidthAtom),
    uiZoom: store.get(uiZoomAtom),
  };
}

const defaults = { sidebarOpen: true, sidebarWidth: 200, uiZoom: 1 };

test("the active Runspace and Tab, the sidebar, and the UI zoom come back after a restart", async () => {
  const { client } = setup();
  await client.runspace.create(size);
  const second = await client.runspace.create(size);
  const tab = await client.tab.open({ runspaceId: second.runspaceId, ...size });

  await saveFrom(client, (store) => {
    store.set(activateRunspaceAtom, second.runspaceId);
    store.set(activateTerminalTabAtom, tab.id);
    store.set(sidebarOpenAtom, false);
    store.set(sidebarWidthAtom, 280);
    store.set(setUiZoomAtom, "in");
  });

  expect(await restart(client)).toEqual({
    runspaceId: second.runspaceId,
    tabId: tab.id,
    sidebarOpen: false,
    sidebarWidth: 280,
    uiZoom: 1.1,
  });
});

test("a saved Runspace that is gone falls back to the first Runspace and its first Tab", async () => {
  const { client } = setup();
  const first = await client.runspace.create(size);
  await client.tab.open({ runspaceId: first.runspaceId, ...size });
  const gone = await client.runspace.create(size);
  await saveFrom(client, (store) => store.set(activateRunspaceAtom, gone.runspaceId));

  await client.runspace.remove({ id: gone.runspaceId });

  expect(await restart(client)).toMatchObject({
    runspaceId: first.runspaceId,
    tabId: first.tab.id,
  });
});

test("a saved Tab that is gone falls back to the first Tab of its Runspace", async () => {
  const { client } = setup();
  await client.runspace.create(size);
  const kept = await client.runspace.create(size);
  const gone = await client.tab.open({ runspaceId: kept.runspaceId, ...size });
  await saveFrom(client, (store) => {
    store.set(activateRunspaceAtom, kept.runspaceId);
    store.set(activateTerminalTabAtom, gone.id);
  });

  await client.tab.close({ id: gone.id });

  expect(await restart(client)).toMatchObject({ runspaceId: kept.runspaceId, tabId: kept.tab.id });
});

test("a saved UI state that is corrupted starts from the defaults", async () => {
  const { client } = setup();
  const first = await client.runspace.create(size);
  const second = await client.runspace.create(size);
  await saveFrom(client, (store) => {
    store.set(activateRunspaceAtom, second.runspaceId);
    store.set(sidebarWidthAtom, 280);
  });

  for (const corrupted of ["{", "null", "[]", '"text"']) {
    for (const key of stored.keys()) stored.set(key, corrupted);
    expect(await restart(client)).toEqual({
      runspaceId: first.runspaceId,
      tabId: first.tab.id,
      ...defaults,
    });
  }
});

test("a localStorage that is empty or cannot be read starts from the defaults", async () => {
  const { client } = setup();
  await client.runspace.create(size);

  expect(await restart(client)).toMatchObject(defaults);

  useStorage({
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {},
  });
  expect(await restart(client)).toMatchObject(defaults);
});
