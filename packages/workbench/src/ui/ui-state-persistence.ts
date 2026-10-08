import { atom, type Store } from 'jotai'

import { layoutAtom } from './backend-copy.ts'
import { activeRunspaceAtom, activeTerminalTabAtom, keptTileAtom } from './navigation.ts'
import {
  collapsedSectionsAtom,
  savedUiStateAtom,
  saveUiState,
  sidebarOpenAtom,
  sidebarWidthAtom,
  type UiState,
  uiZoomAtom,
} from './ui-state.ts'

const SAVE_DEBOUNCE_MS = 500

const uiStateAtom = atom((get): UiState => {
  // layout を読む前は先頭への fallback も決まっていないので、読み込んだ値をそのまま残す。
  const saved = get(savedUiStateAtom)
  const loaded = get(layoutAtom) !== null
  return {
    activeRunspaceId: loaded ? (get(activeRunspaceAtom)?.id ?? null) : saved.activeRunspaceId,
    activeTabId: loaded ? (get(activeTerminalTabAtom)?.id ?? null) : saved.activeTabId,
    sidebarOpen: get(sidebarOpenAtom),
    sidebarWidth: get(sidebarWidthAtom),
    uiZoom: get(uiZoomAtom),
    tile: get(keptTileAtom),
    collapsedSections: [...get(collapsedSectionsAtom)],
  }
})

export function persistUiState(store: Store): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest = JSON.stringify(store.get(uiStateAtom))
  const flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    saveUiState(store.get(uiStateAtom))
  }
  // layout を読み直すたびに通知が来るので、保存する値が変わったときだけ予約し直す。
  const unsubscribe = store.sub(uiStateAtom, () => {
    const next = JSON.stringify(store.get(uiStateAtom))
    if (next === latest) return
    latest = next
    clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  })
  // 窓を閉じると予約した timer ごと消えるので、待っている値をその前に書く。
  addEventListener('pagehide', flush)
  return () => {
    removeEventListener('pagehide', flush)
    unsubscribe()
    flush()
  }
}
