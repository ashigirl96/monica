import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  /** 直前に区切り線を挟む（破壊的な項目を誤クリックから離す用途） */
  separatorBefore?: boolean;
}

/** 右クリック位置と対象を束ねて持つ。closeMenu が安定なので ContextMenu の
 * window リスナが親の再描画ごとに張り直されない。 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ x: number; y: number; target: T } | null>(null);
  const openMenu = useCallback((e: ReactMouseEvent, target: T) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  return { menu, openMenu, closeMenu };
}

/**
 * 右クリックメニュー。開閉状態と発火座標は呼び出し側（useContextMenu）が持ち、ここは
 * 画面内に収める配置と「外側クリック・Escape・スクロールで閉じる」だけを引き受ける。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // paint 前に実測サイズで clamp する（useEffect だと画面外に一瞬はみ出て見える）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const margin = 8;
    const fit = (v: number, size: number, limit: number) =>
      Math.max(margin, Math.min(v, limit - size - margin));
    setPos({
      left: fit(x, el.offsetWidth, window.innerWidth),
      top: fit(y, el.offsetHeight, window.innerHeight),
    });
  }, [x, y]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="menu"
      className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore && <div className="my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-sm transition-colors ${
              item.destructive ? "text-destructive hover:bg-destructive/10" : "hover:bg-muted"
            }`}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
