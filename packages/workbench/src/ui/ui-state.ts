import { atom } from 'jotai'
import { atomWithDefault } from 'jotai/utils'

import { clamp } from './clamp.ts'

export const SIDEBAR_DEFAULT_WIDTH = 200
export const SIDEBAR_MIN_WIDTH = 160
export const SIDEBAR_MAX_WIDTH = 360

const UI_ZOOM_MIN = 0.8
const UI_ZOOM_MAX = 1.6
const UI_ZOOM_DEFAULT = 1
const UI_ZOOM_STEP = 0.1

// Workbench Ledger に載せない画面の状態（ADR-0014）。active でない Runspace の active Tab と端末の font size は持たない。
export type UiState = {
  activeRunspaceId: string | null
  activeTabId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  uiZoom: number
  rail: string | null
  collapsedSections: string[]
}

const UI_STATE_KEY = 'tania.workbench.ui-state'

const DEFAULT_UI_STATE: UiState = {
  activeRunspaceId: null,
  activeTabId: null,
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  uiZoom: UI_ZOOM_DEFAULT,
  rail: null,
  collapsedSections: [],
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function parseUiState(text: string | null): UiState {
  const raw: unknown = text === null ? null : JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_UI_STATE
  const r = raw as Record<string, unknown>
  return {
    activeRunspaceId: typeof r.activeRunspaceId === 'string' ? r.activeRunspaceId : null,
    activeTabId: typeof r.activeTabId === 'string' ? r.activeTabId : null,
    sidebarOpen: typeof r.sidebarOpen === 'boolean' ? r.sidebarOpen : DEFAULT_UI_STATE.sidebarOpen,
    sidebarWidth: numberIn(
      r.sidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
      SIDEBAR_DEFAULT_WIDTH,
    ),
    uiZoom: numberIn(r.uiZoom, UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_DEFAULT),
    rail: typeof r.rail === 'string' ? r.rail : null,
    collapsedSections: Array.isArray(r.collapsedSections)
      ? r.collapsedSections.filter((key): key is string => typeof key === 'string')
      : [],
  }
}

// localStorage は private window や site data の遮断で投げることがある。
export const savedUiStateAtom = atom((): UiState => {
  try {
    return parseUiState(localStorage.getItem(UI_STATE_KEY))
  } catch {
    return DEFAULT_UI_STATE
  }
})

export function saveUiState(state: UiState): void {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(state))
  } catch (e) {
    console.warn('ui-state save failed:', e)
  }
}

export const sidebarOpenAtom = atomWithDefault((get) => get(savedUiStateAtom).sidebarOpen)
export const sidebarWidthAtom = atomWithDefault((get) => get(savedUiStateAtom).sidebarWidth)
export const sidebarResizingAtom = atom(false)

// null なら active な Runspace の札を出す。
export const railChoiceAtom = atomWithDefault((get) => get(savedUiStateAtom).rail)
export const collapsedSectionsAtom = atomWithDefault(
  (get): ReadonlySet<string> => new Set(get(savedUiStateAtom).collapsedSections),
)

// メインコンテンツ領域だけに CSS zoom として適用する係数。chrome (sidebar/header)
// はこの atom を読まないので固定のまま。ターミナルは content 側で 1/zoom の逆 zoom を
// 当てて net 1.0 に戻し、独立した px フォント管理 (terminalFontSizeAtom) を保つ。
export const uiZoomAtom = atomWithDefault((get) => get(savedUiStateAtom).uiZoom)

export const setUiZoomAtom = atom(null, (get, set, action: 'in' | 'out' | 'reset') => {
  const current = get(uiZoomAtom)
  const raw =
    action === 'reset'
      ? UI_ZOOM_DEFAULT
      : current + (action === 'in' ? UI_ZOOM_STEP : -UI_ZOOM_STEP)
  set(uiZoomAtom, clamp(Math.round(raw * 10) / 10, UI_ZOOM_MIN, UI_ZOOM_MAX))
})
