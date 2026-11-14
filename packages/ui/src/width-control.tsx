import { useCallback, useEffect, useRef, useState } from 'react'

import { usePopupDismiss } from './use-popup-dismiss.ts'
import {
  applyWidth,
  setWidthPref,
  WIDTH_EXTRA_MAX,
  WIDTH_EXTRA_STEP,
  type WidthPref,
  widthPref,
} from './width-pref.ts'

/**
 * 本文カラムの幅を広げるスライダーのピル。既定幅が 0 で、+px ぶんだけ左右へ対称に伸びる。
 * popupBelow は、画面の上端に置いたピルの popup を下へ開く。
 */
export function WidthControl({
  pref,
  label,
  popupBelow = false,
}: {
  pref: WidthPref
  label: string
  popupBelow?: boolean
}) {
  const [extra, setExtra] = useState(() => widthPref(pref))
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  usePopupDismiss({ open, rootRef, triggerRef, onClose: close })

  // 幅の CSS 変数は本文カラムの max-width に効くので、変えるたび本文全体の
  // レイアウトが走る。スライダーの入力イベントをそのまま流さず rAF で 1 フレーム 1 回に
  // 間引く（notes-shell のサイドバーリサイズと同じ理由）
  const frame = useRef(0)
  const pending = useRef(extra)
  const onSlide = (value: number) => {
    setExtra(value)
    pending.current = value
    if (frame.current === 0) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        applyWidth(pref, pending.current)
      })
    }
  }
  // 永続化はドラッグ中ではなく離したときだけ（毎イベントの同期 I/O を避ける）
  const commit = () => setWidthPref(pref, pending.current)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`${label}: +${extra}px`}
        title={`${label}: +${extra}px`}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-full border bg-card/75 py-1.5 pr-3.5 pl-1.5 shadow-sm backdrop-blur-sm transition-opacity hover:opacity-100 ${
          open ? 'opacity-100' : 'opacity-55'
        }`}
      >
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full border bg-muted text-muted-foreground"
        >
          <svg
            className="size-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 5v14M20 5v14M8 12h8M8 12l2.5-2.5M8 12l2.5 2.5M16 12l-2.5-2.5M16 12l-2.5 2.5"
            />
          </svg>
        </span>
        <span className="font-mono text-[0.6rem] tracking-widest text-muted-foreground uppercase">
          +{extra}
        </span>
      </button>

      {open && (
        <div
          role="group"
          aria-label={label}
          className={`absolute right-0 ${popupBelow ? 'top-full mt-2' : 'bottom-full mb-2'} z-50 w-52 rounded-xl border bg-card p-3 shadow-xl`}
        >
          <div className="flex items-center justify-between font-mono text-[0.6rem] tracking-widest text-muted-foreground uppercase">
            <span>Width</span>
            <span>+{extra}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={WIDTH_EXTRA_MAX}
            step={WIDTH_EXTRA_STEP}
            value={extra}
            aria-label={`Extra ${label.toLowerCase()}`}
            onChange={(e) => onSlide(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="mt-2.5 w-full accent-foreground"
          />
          <button
            type="button"
            onClick={() => {
              onSlide(0)
              setWidthPref(pref, 0)
            }}
            className="mt-1.5 w-full rounded-lg p-1 font-mono text-[0.6rem] tracking-widest text-muted-foreground uppercase transition-colors hover:bg-muted/60"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
