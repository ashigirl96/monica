import { atom, type Store } from 'jotai'

import {
  activateRunspaceAtom,
  activateTerminalTabAtom,
  activeRunspaceAtom,
  activeTerminalTabAtom,
  shownRunspaceIdsAtom,
} from './navigation.ts'

// 2 度目の d を待つ Tab は jump モードの中にだけ置き、どの経路でモードを抜けても忘れる。
const jumpModeAtom = atom<{ pendingCloseTabId: string | null } | null>(null)

export const jumpHintsActiveAtom = atom(
  (get) => get(jumpModeAtom) !== null,
  (_get, set, active: boolean) => set(jumpModeAtom, active ? { pendingCloseTabId: null } : null),
)

export const pendingCloseTabIdAtom = atom(
  (get) => get(jumpModeAtom)?.pendingCloseTabId ?? null,
  (get, set, tabId: string) => {
    if (get(jumpModeAtom)) set(jumpModeAtom, { pendingCloseTabId: tabId })
  },
)

const frontAtom = atom((get) => `${get(activeRunspaceAtom)?.id}/${get(activeTerminalTabAtom)?.id}`)

// hint は表示している画面の行と Tab に振った番号なので、表示する Tab が替わったら jump モードを抜ける。
export function leaveJumpModeOnSwitch(store: Store): () => void {
  return store.sub(frontAtom, () => store.set(jumpHintsActiveAtom, false))
}

// Both use digits in visual order; Ctrl disambiguates runspace (⌃1) from tab (1).
const HINT_KEYS = '123456789'.split('')

type JumpHintTargets = {
  byRunspaceId: Record<string, string>
  byTabId: Record<string, string>
}

const NO_HINT_TARGETS: JumpHintTargets = { byRunspaceId: {}, byTabId: {} }

export const jumpHintTargetsAtom = atom((get): JumpHintTargets => {
  // 2 度目の d を待つ間は、数字を押しても移らず取り消すだけなので hint を出さない。
  if (!get(jumpHintsActiveAtom) || get(pendingCloseTabIdAtom)) return NO_HINT_TARGETS
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

export const jumpToHintAtom = atom(null, (get, set, input: { key: string; runspace: boolean }) => {
  // Read before dismissing: the targets atom empties once hints deactivate.
  const targets = get(jumpHintTargetsAtom)
  set(jumpHintsActiveAtom, false)
  const byId = input.runspace ? targets.byRunspaceId : targets.byTabId
  const match = Object.entries(byId).find(([, key]) => key === input.key)
  if (!match) return
  if (input.runspace) {
    set(activateRunspaceAtom, match[0])
  } else {
    set(activateTerminalTabAtom, match[0])
  }
})
