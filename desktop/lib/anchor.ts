import type { PopoverAnchor } from "@/components/popover-menu";

export function rectToAnchor(rect: DOMRect): PopoverAnchor {
  return { top: rect.top, bottom: rect.bottom, left: rect.left };
}
