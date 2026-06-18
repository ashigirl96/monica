import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ANCHOR_GAP = 4;
const VIEWPORT_PADDING = 8;

export type PopoverAnchor = { top: number; bottom: number; left: number };

export function PopoverMenu({
  anchor,
  onClose,
  children,
}: {
  anchor: PopoverAnchor;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The anchor rect is captured at open time; measure the menu itself before
  // showing it so it can flip above the anchor near the bottom edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(anchor.left, VIEWPORT_PADDING),
      window.innerWidth - width - VIEWPORT_PADDING,
    );
    let top = anchor.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - VIEWPORT_PADDING) {
      top = anchor.top - height - ANCHOR_GAP;
    }
    setPos({ top, left });
  }, [anchor]);

  // The menu does not track its anchor; any scroll or resize just closes it.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("scroll", onClose, { capture: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("scroll", onClose, { capture: true });
      window.removeEventListener("resize", onClose);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      style={
        pos
          ? { top: pos.top, left: pos.left }
          : { top: anchor.bottom + ANCHOR_GAP, left: anchor.left, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
