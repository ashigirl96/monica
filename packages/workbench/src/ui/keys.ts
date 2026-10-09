import { atom, type Store } from 'jotai'

import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  cycleRunspaceAtom,
  cycleTerminalTabAtom,
  pickTileByNumberAtom,
  shownRunspaceIdsAtom,
} from './navigation.ts'
import {
  action,
  closeTerminalTabAtom,
  copyActiveAgentSessionIdAtom,
  createRunspaceAtom,
  createTerminalTabAtom,
  hasLiveAgentSession,
  moveActiveRunspaceAtom,
  moveActiveTabAtom,
  toggleTabPinAtom,
} from './store.ts'
import { setUiZoomAtom, sidebarOpenAtom } from './ui-state.ts'

export type KeyFacts = {
  key: string
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  repeat: boolean
  editable: boolean
}

export type Pressed = { handled: boolean; done: Promise<void> }

type Binding = {
  key?: string
  keys?: string[]
  code?: string
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  editable?: boolean
  // false を返すと、キーを取らずにブラウザの既定の動作に任せる。
  action: (store: Store, key: KeyFacts) => unknown
}

// 2 度目の d を待つ Tab は Jump Mode の中にだけ置き、どの経路で抜けても忘れる。
const jumpModeAtom = atom<{ pendingCloseTabId: string | null } | null>(null)

export const jumpModeActiveAtom = atom((get) => get(jumpModeAtom) !== null)

export const pendingCloseTabIdAtom = atom((get) => get(jumpModeAtom)?.pendingCloseTabId ?? null)

// Runspace と Tab の hint はどちらも見た目の順の数字で、Ctrl の有無で見分ける。
const HINT_KEYS = '123456789'.split('')

type JumpHintTargets = {
  byRunspaceId: Record<string, string>
  byTabId: Record<string, string>
}

const NO_HINT_TARGETS: JumpHintTargets = { byRunspaceId: {}, byTabId: {} }

export const jumpHintTargetsAtom = atom((get): JumpHintTargets => {
  // 2 度目の d を待つ間は、数字を押しても移らず取り消すだけなので hint を出さない。
  if (!get(jumpModeActiveAtom) || get(pendingCloseTabIdAtom)) return NO_HINT_TARGETS
  const ordered = get(shownRunspaceIdsAtom)
  const tabs = get(activeRunspaceAtom)?.tabs ?? []

  const byRunspaceId: Record<string, string> = {}
  const byTabId: Record<string, string> = {}
  ordered.slice(0, HINT_KEYS.length).forEach((id, i) => {
    byRunspaceId[id] = HINT_KEYS[i]!
  })
  tabs.slice(0, HINT_KEYS.length).forEach((t, i) => {
    byTabId[t.id] = HINT_KEYS[i]!
  })
  return { byRunspaceId, byTabId }
})

const jumpToHintAtom = atom(null, (get, set, input: { key: string; runspace: boolean }) => {
  // Read before dismissing: the targets atom empties once hints deactivate.
  const targets = get(jumpHintTargetsAtom)
  set(jumpModeAtom, null)
  const byId = input.runspace ? targets.byRunspaceId : targets.byTabId
  const match = Object.entries(byId).find(([, key]) => key === input.key)
  if (!match) return
  if (input.runspace) {
    set(activateRunspaceAtom, match[0])
  } else {
    set(activateTerminalTabAtom, match[0])
  }
})

// d は c（新しい Tab）の隣のキーなので、claude の居る Tab は打ち損じで消さないよう 2 度目の d を待つ。
const closeTabFromJumpModeAtom = action(async (get, set) => {
  const front = get(activeTerminalTabAtom)
  const pending = get(pendingCloseTabIdAtom)
  // 尋ねた Tab が shell の終了で先に閉じたら、手前に来た別の Tab は誰も確かめていない。
  if (!front || front.pinned || (pending !== null && pending !== front.id)) {
    set(jumpModeAtom, null)
    return
  }
  if (pending !== front.id) {
    const live = await hasLiveAgentSession(get, front.terminalSessionId)
    // 聞く間にほかのキーや Tab の切り替えで Jump Mode を抜けていたら、その操作を優先する。
    if (!get(jumpModeAtom)) return
    if (live) {
      set(jumpModeAtom, { pendingCloseTabId: front.id })
      return
    }
  }
  set(jumpModeAtom, null)
  await set(closeTerminalTabAtom, front.id)
})

const frontAtom = atom((get) => `${get(activeRunspaceAtom)?.id}/${get(activeTerminalTabAtom)?.id}`)

// hint は表示している画面の行と Tab に振った番号なので、表示する Tab が替わったら Jump Mode を抜ける。
export function leaveJumpModeOnSwitch(store: Store): () => void {
  return store.sub(frontAtom, () => store.set(jumpModeAtom, null))
}

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

const NOT_TAKEN: Pressed = { handled: false, done: Promise.resolve() }

function taken(result: unknown): Pressed {
  return { handled: true, done: Promise.resolve(result).then(() => {}) }
}

function pressInJumpMode(store: Store, key: KeyFacts): Pressed {
  if (MODIFIER_KEYS.has(key.key)) return NOT_TAKEN

  if (key.key === 'd' && !key.ctrl) {
    // 長押しの自動の繰り返しを 2 度目の d と数えると、確認を待たずに claude の居る Tab を閉じる。
    return taken(key.repeat ? undefined : store.set(closeTabFromJumpModeAtom))
  }

  // 2 度目の d を待つ間は hint を隠しているので、ほかのキーは見えない hint へ移らずに取り消すだけにする。
  if (store.get(pendingCloseTabIdAtom) !== null || (key.ctrl && key.key === 't')) {
    store.set(jumpModeAtom, null)
    return taken(undefined)
  }

  if (key.key === 'c' && !key.ctrl) {
    store.set(jumpModeAtom, null)
    return taken(store.set(createTerminalTabAtom))
  }

  if (key.key === 'H' || key.key === 'L') {
    return taken(store.set(moveActiveTabAtom, key.key === 'H' ? 'left' : 'right'))
  }

  if (key.key === 'J' || key.key === 'K') {
    return taken(store.set(moveActiveRunspaceAtom, key.key === 'K' ? 'up' : 'down'))
  }

  store.set(jumpToHintAtom, { key: key.key.toLowerCase(), runspace: key.ctrl })
  return taken(undefined)
}

function matches(b: Binding, key: KeyFacts): boolean {
  if (Boolean(b.meta) !== key.meta) return false
  if (Boolean(b.ctrl) !== key.ctrl) return false
  if (Boolean(b.alt) !== key.alt) return false
  if (b.shift && !key.shift) return false
  if (b.shift === false && key.shift) return false
  if (b.key !== undefined && key.key !== b.key) return false
  if (b.keys !== undefined && !b.keys.includes(key.key)) return false
  if (b.code !== undefined && key.code !== b.code) return false
  return true
}

export function createKeymap(bindings: Binding[]) {
  // 入力欄の中では ⌥ のキーと editable の binding だけを取り、ほかは入力欄に任せる。
  function bindingFor(key: KeyFacts): Binding | undefined {
    const skipNonEditable = key.editable && !key.alt
    return bindings.find((b) => !(skipNonEditable && !b.editable) && matches(b, key))
  }

  return {
    press(store: Store, key: KeyFacts): Pressed {
      if (store.get(jumpModeAtom)) return pressInJumpMode(store, key)
      const binding = bindingFor(key)
      if (!binding) return NOT_TAKEN
      const result = binding.action(store, key)
      return result === false ? NOT_TAKEN : taken(result)
    },
    // binding が false を返して素通しするキーも、端末には届けない。
    takesFromTerminal(store: Store, e: KeyboardEvent): boolean {
      return store.get(jumpModeAtom) !== null || bindingFor(keyFacts(e, true)) !== undefined
    },
  }
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export const keymap = createKeymap([
  {
    meta: true,
    ctrl: true,
    key: '0',
    editable: true,
    action: (s) => s.set(setUiZoomAtom, 'reset'),
  },
  { alt: true, code: 'KeyP', editable: true, action: (s) => s.set(createRunspaceAtom) },
  { alt: true, code: 'KeyJ', editable: true, action: (s) => s.set(cycleRunspaceAtom, 'down') },
  { alt: true, code: 'KeyC', editable: true, action: (s) => s.set(copyActiveAgentSessionIdAtom) },
  { alt: true, code: 'KeyK', editable: true, action: (s) => s.set(cycleRunspaceAtom, 'up') },
  {
    ctrl: true,
    key: 'Tab',
    editable: true,
    action: (s, key) => s.set(cycleTerminalTabAtom, key.shift ? 'left' : 'right'),
  },
  {
    ctrl: true,
    key: 't',
    editable: true,
    action: (s) => s.set(jumpModeAtom, { pendingCloseTabId: null }),
  },
  { meta: true, key: 'b', editable: true, action: (s) => s.set(sidebarOpenAtom, (v) => !v) },
  // macOS の印刷ダイアログは preventDefault で抑えられる。
  { meta: true, shift: false, key: 'p', editable: true, action: (s) => s.set(toggleTabPinAtom) },
  {
    meta: true,
    shift: false,
    keys: DIGITS,
    editable: true,
    action: (s, key) => s.set(pickTileByNumberAtom, Number(key.key)),
  },
  { meta: true, keys: ['=', '+'], action: (s) => s.set(setUiZoomAtom, 'in') },
  { meta: true, key: '-', action: (s) => s.set(setUiZoomAtom, 'out') },
  { alt: true, code: 'KeyH', action: (s) => s.set(cycleTerminalTabAtom, 'left') },
  { alt: true, code: 'KeyL', action: (s) => s.set(cycleTerminalTabAtom, 'right') },
])

export function keyFacts(e: KeyboardEvent, editable: boolean): KeyFacts {
  return {
    key: e.key,
    code: e.code,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    repeat: e.repeat,
    editable,
  }
}

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']"

export function followKeys(store: Store): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const editable = e.target instanceof HTMLElement && e.target.closest(EDITABLE_SELECTOR) !== null
    if (keymap.press(store, keyFacts(e, editable)).handled) e.preventDefault()
  }
  const onPointerDown = () => {
    if (store.get(jumpModeAtom)) store.set(jumpModeAtom, null)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointerdown', onPointerDown, true)
  const stopLeavingOnSwitch = leaveJumpModeOnSwitch(store)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('pointerdown', onPointerDown, true)
    stopLeavingOnSwitch()
  }
}
