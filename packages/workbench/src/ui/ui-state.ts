import { atom } from "jotai";
import { clamp } from "./clamp.ts";

export const SIDEBAR_DEFAULT_WIDTH = 200;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

export const sidebarOpenAtom = atom(true);
export const sidebarWidthAtom = atom(SIDEBAR_DEFAULT_WIDTH);
export const sidebarResizingAtom = atom(false);

const UI_ZOOM_MIN = 0.8;
const UI_ZOOM_MAX = 1.6;
const UI_ZOOM_DEFAULT = 1;
const UI_ZOOM_STEP = 0.1;

// メインコンテンツ領域だけに CSS zoom として適用する係数。chrome (sidebar/header)
// はこの atom を読まないので固定のまま。ターミナルは content 側で 1/zoom の逆 zoom を
// 当てて net 1.0 に戻し、独立した px フォント管理 (terminalFontSizeAtom) を保つ。
export const uiZoomAtom = atom(UI_ZOOM_DEFAULT);

export const setUiZoomAtom = atom(null, (get, set, action: "in" | "out" | "reset") => {
  const current = get(uiZoomAtom);
  const raw =
    action === "reset"
      ? UI_ZOOM_DEFAULT
      : current + (action === "in" ? UI_ZOOM_STEP : -UI_ZOOM_STEP);
  set(uiZoomAtom, clamp(Math.round(raw * 10) / 10, UI_ZOOM_MIN, UI_ZOOM_MAX));
});
