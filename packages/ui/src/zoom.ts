// Chromium のページ拡大と同じ段階にし、ブラウザの拡大と同じ手触りにする。
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export type ZoomStep = 'in' | 'out' | 'reset'

export function nextZoom(zoom: number, step: ZoomStep): number {
  if (step === 'reset') return 1
  const i = ZOOM_STEPS.indexOf(zoom) + (step === 'in' ? 1 : -1)
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i))]!
}
