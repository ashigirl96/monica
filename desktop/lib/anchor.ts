import type { PopoverAnchor } from "@/components/popover-menu";

export type Rect = { top: number; bottom: number; left: number; right: number };

export function rectToAnchor(rect: { top: number; bottom: number; left: number }): PopoverAnchor {
  return { top: rect.top, bottom: rect.bottom, left: rect.left };
}

export function anchorForSelector(selector: string): PopoverAnchor | null {
  const el = document.querySelector<HTMLElement>(selector);
  return el ? rectToAnchor(el.getBoundingClientRect()) : null;
}

// The part of `rect` that survives every clip, or null once nothing is left of it.
export function clipRect(rect: Rect, clips: Rect[]): Rect | null {
  const clipped = clips.reduce<Rect>(
    (acc, clip) => ({
      top: Math.max(acc.top, clip.top),
      bottom: Math.min(acc.bottom, clip.bottom),
      left: Math.max(acc.left, clip.left),
      right: Math.min(acc.right, clip.right),
    }),
    rect,
  );
  return clipped.bottom > clipped.top && clipped.right > clipped.left ? clipped : null;
}

function clippingRects(el: HTMLElement): Rect[] {
  const rects: Rect[] = [{ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }];
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (overflowX !== "visible" || overflowY !== "visible") rects.push(p.getBoundingClientRect());
  }
  return rects;
}

// An element scrolled out of its container — or sitting in a panel collapsed to zero width —
// keeps reporting a rect, so plain `anchorForSelector` would drop a menu where nobody can see it.
// Anchoring to the clipped rect keeps a half-scrolled row tied to the part still on screen.
export function visibleAnchorForSelector(selector: string): PopoverAnchor | null {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const visible = clipRect(el.getBoundingClientRect(), clippingRects(el));
  return visible ? rectToAnchor(visible) : null;
}
