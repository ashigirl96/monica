import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyNoteWidth,
  NOTE_EXTRA_MAX,
  NOTE_EXTRA_STEP,
  noteWidthPref,
  setNoteWidthPref,
} from "@/note-width";
import { usePopupDismiss } from "./use-popup-dismiss";

/**
 * ノート本文カラムの幅を広げるスライダー。AmbientSwitcher と同じ右下常駐ピルの一員。
 * 既定幅が 0 で、+px ぶんだけ左右へ対称に伸びる。
 */
export function NoteWidthControl() {
  const [extra, setExtra] = useState<number>(noteWidthPref);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopupDismiss({ open, rootRef, triggerRef, onClose: close });

  // --note-extra-w は本文カラムの max-width に効くので、変えるたび ProseMirror 全体の
  // レイアウトが走る。スライダーの入力イベントをそのまま流さず rAF で 1 フレーム 1 回に
  // 間引く（notes-shell のサイドバーリサイズと同じ理由）
  const frame = useRef(0);
  const pending = useRef(extra);
  const onSlide = (value: number) => {
    setExtra(value);
    pending.current = value;
    if (frame.current === 0) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        applyNoteWidth(pending.current);
      });
    }
  };
  // 永続化はドラッグ中ではなく離したときだけ（毎イベントの同期 I/O を避ける）
  const commit = () => setNoteWidthPref(pending.current);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`Editor width: +${extra}px`}
        title={`Editor width: +${extra}px`}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-full border bg-card/75 py-1.5 pr-3.5 pl-1.5 shadow-sm backdrop-blur-sm transition-opacity hover:opacity-100 ${
          open ? "opacity-100" : "opacity-55"
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
        <span className="font-mono text-[0.6rem] uppercase tracking-widest text-muted-foreground">
          +{extra}
        </span>
      </button>

      {open && (
        <div
          role="group"
          aria-label="Editor width"
          className="absolute right-0 bottom-full mb-2 w-52 rounded-xl border bg-card p-3 shadow-xl"
        >
          <div className="flex items-center justify-between font-mono text-[0.6rem] uppercase tracking-widest text-muted-foreground">
            <span>Width</span>
            <span>+{extra}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={NOTE_EXTRA_MAX}
            step={NOTE_EXTRA_STEP}
            value={extra}
            aria-label="Extra editor width"
            onChange={(e) => onSlide(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="mt-2.5 w-full accent-foreground"
          />
          <button
            type="button"
            onClick={() => {
              onSlide(0);
              setNoteWidthPref(0);
            }}
            className="mt-1.5 w-full rounded-lg p-1 font-mono text-[0.6rem] uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted/60"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
