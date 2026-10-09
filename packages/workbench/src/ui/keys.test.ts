import { afterEach, expect, test } from 'bun:test'

import { createStore, type Store } from 'jotai'

import { cleanUp, setup } from '../testing.ts'
import { createKeymap, keyFacts, keymap } from './keys.ts'
import { activateRunspaceAtom, activeRunspaceAtom, activeTerminalTabAtom } from './navigation.ts'
import { reloadAtom, workbenchClientAtom } from './store.ts'
import { buildKeyEventHandler } from './terminal-setup.ts'
import { sidebarOpenAtom, uiZoomAtom } from './ui-state.ts'

const size = { rows: 24, cols: 80 }

afterEach(cleanUp)

type Modifiers = { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }

function keydown(key: string, code: string, mods: Modifiers = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    code,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    repeat: false,
    preventDefault: () => {},
  } as KeyboardEvent
}

// 端末にフォーカスがあると、キーは xterm の handler を通った後に window へ上がる。
function inTerminal(store: Store, map = keymap) {
  const zooms: number[] = []
  const xterm = buildKeyEventHandler(
    (e) => map.takesFromTerminal(store, e),
    (delta) => zooms.push(delta),
    () => {},
  )
  return {
    zooms,
    press: (e: KeyboardEvent) => ({
      toTerminal: xterm(e),
      handled: map.press(store, keyFacts(e, true)).handled,
    }),
  }
}

test('with the terminal focused, the ⌥, ⌃Tab and ⌘ bindings act and ⌘= / ⌘- zoom the terminal, not the UI', async () => {
  const { client } = setup()
  const store = createStore()
  store.set(workbenchClientAtom, () => client)
  const first = await client.runspace.create(size)
  await client.tab.open({ runspaceId: first.runspaceId, ...size })
  await client.runspace.create(size)
  await store.set(reloadAtom)
  store.set(activateRunspaceAtom, first.runspaceId)
  const sidebarOpen = store.get(sidebarOpenAtom)
  const uiZoom = store.get(uiZoomAtom)
  const terminal = inTerminal(store)

  const ctrlTab = terminal.press(keydown('Tab', 'Tab', { ctrl: true }))
  const shownTab = store.get(activeTerminalTabAtom)?.id
  const altH = terminal.press(keydown('˙', 'KeyH', { alt: true }))
  const backTab = store.get(activeTerminalTabAtom)?.id
  const altJ = terminal.press(keydown('∆', 'KeyJ', { alt: true }))
  const metaB = terminal.press(keydown('b', 'KeyB', { meta: true }))

  const acted = { toTerminal: false, handled: true }
  expect([ctrlTab, altH, altJ, metaB]).toEqual([acted, acted, acted, acted])
  expect(shownTab).not.toBe(first.tab.id)
  expect(backTab).toBe(first.tab.id)
  expect(store.get(activeRunspaceAtom)?.id).not.toBe(first.runspaceId)
  expect(store.get(sidebarOpenAtom)).toBe(!sidebarOpen)

  const zoomed = [
    terminal.press(keydown('=', 'Equal', { meta: true })),
    terminal.press(keydown('-', 'Minus', { meta: true })),
  ]

  expect(zoomed).toEqual([
    { toTerminal: false, handled: false },
    { toTerminal: false, handled: false },
  ])
  expect(terminal.zooms).toEqual([1, -1])
  expect(store.get(uiZoomAtom)).toBe(uiZoom)
})

test('a key added to the binding table is taken from the focused terminal and acts', () => {
  const store = createStore()
  const ctrlG = keydown('g', 'KeyG', { ctrl: true })
  let acted = 0
  const extended = createKeymap([{ ctrl: true, key: 'g', editable: true, action: () => acted++ }])

  const before = inTerminal(store).press(ctrlG)
  const after = inTerminal(store, extended).press(ctrlG)

  expect([before, after]).toEqual([
    { toTerminal: true, handled: false },
    { toTerminal: false, handled: true },
  ])
  expect(acted).toBe(1)
})
