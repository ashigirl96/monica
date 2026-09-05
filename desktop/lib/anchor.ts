import type { PopoverAnchor } from "@/components/popover-menu";

export function rectToAnchor(rect: DOMRect): PopoverAnchor {
  return { top: rect.top, bottom: rect.bottom, left: rect.left };
}

export function anchorForSelector(selector: string): PopoverAnchor | null {
  const el = document.querySelector<HTMLElement>(selector);
  return el ? rectToAnchor(el.getBoundingClientRect()) : null;
}
