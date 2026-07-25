import { useEffect, useRef, useState } from "react";
import { type AmbientName, AMBIENT_NAMES, AMBIENTS, ambientPref, setAmbientPref } from "@/ambient";

/**
 * 画面右下に常駐する背景の切り替え。設定画面へ行かずに、書いている手を止めずに
 * 気分を変えられることが存在理由なので、zen mode でも隠さない。
 *
 * AppShell 直下 = .notes-screen の外側にいるため、--ink-* / --paper は参照できない。
 * 配色は globals.css の global token（card / muted / border）で組む。
 */
/** 写真なし（image: null）は敷くものが無いので、斜線を引いた空のスウォッチで表す */
function swatch(image: string | null) {
  return {
    backgroundImage:
      image === null
        ? "linear-gradient(to top right, transparent 47%, var(--color-border) 47%, var(--color-border) 53%, transparent 53%)"
        : `url("${image}")`,
  };
}

export function AmbientSwitcher() {
  const [selected, setSelected] = useState<AmbientName>(ambientPref);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = AMBIENTS[selected];

  return (
    <div ref={rootRef} className="fixed right-4 bottom-4 z-40">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Ambient: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-full border bg-card/75 py-1.5 pr-3.5 pl-1.5 shadow-sm backdrop-blur-sm transition-opacity hover:opacity-100 ${
          open ? "opacity-100" : "opacity-55"
        }`}
      >
        <span
          aria-hidden
          style={swatch(current.image)}
          className="size-6 rounded-full border bg-muted bg-cover bg-center"
        />
        <span className="font-mono text-[0.6rem] uppercase tracking-widest text-muted-foreground">
          {current.label}
        </span>
      </button>

      {/* listbox / option ロールは使わない: それらは矢印キーと roving focus を実装済みだと
          宣言してしまう契約で、ここは Tab で辿る素のボタン列（context-menu.tsx と同じ流儀）。
          trigger より後に置くのは、absolute なので配置は変わらないまま Tab が前方向で
          選択肢に入るようにするため。 */}
      {open && (
        <div
          role="group"
          aria-label="Ambient background"
          className="absolute right-0 bottom-full mb-2 w-52 rounded-xl border bg-card p-1.5 shadow-xl"
        >
          {AMBIENT_NAMES.map((name) => {
            const ambient = AMBIENTS[name];
            const active = name === selected;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setAmbientPref(name);
                  setSelected(name);
                }}
                className={`flex w-full items-center gap-3 rounded-lg p-1.5 text-left transition-colors ${
                  active ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                <span
                  aria-hidden
                  style={swatch(ambient.image)}
                  className="size-9 shrink-0 rounded-md border bg-muted bg-cover bg-center"
                />
                <span className={`text-sm ${active ? "text-foreground" : "text-muted-foreground"}`}>
                  {ambient.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
