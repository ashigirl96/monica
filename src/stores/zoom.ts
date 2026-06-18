import { atom } from "jotai";
import { clamp } from "@/lib/clamp";

export const UI_ZOOM_MIN = 0.8;
export const UI_ZOOM_MAX = 1.6;
export const UI_ZOOM_DEFAULT = 1;
export const UI_ZOOM_STEP = 0.1;

export function clampUiZoom(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return UI_ZOOM_DEFAULT;
  return clamp(v, UI_ZOOM_MIN, UI_ZOOM_MAX);
}

// メインコンテンツ領域だけに CSS zoom として適用する係数。chrome (sidebar/header/space-nav)
// はこの atom を読まないので固定のまま。ターミナルは WorkBenchContent 側で 1/zoom の逆 zoom を
// 当てて net 1.0 に戻し、独立した px フォント管理 (terminalFontSizeAtom) を保つ。
export const uiZoomAtom = atom(UI_ZOOM_DEFAULT);

export const setUiZoomAtom = atom(null, (get, set, action: "in" | "out" | "reset") => {
  const current = get(uiZoomAtom);
  const raw =
    action === "reset"
      ? UI_ZOOM_DEFAULT
      : current + (action === "in" ? UI_ZOOM_STEP : -UI_ZOOM_STEP);
  set(uiZoomAtom, clampUiZoom(Math.round(raw * 10) / 10));
});
