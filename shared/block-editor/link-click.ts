import { Plugin } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { schema } from "./schema";
import { openExternal } from "./node-views";

export function linkHrefAt(doc: PMNode, pos: number): string | null {
  const $pos = doc.resolve(pos);
  const child = $pos.parent.childAfter($pos.parentOffset);
  const link = child.node?.marks.find((m) => m.type === schema.marks.link);
  return link ? (link.attrs.href as string) : null;
}

// link mark の <a> はクリックしてもナビゲーションされないため、クリック位置の
// mark から href を引いて明示的に開く。node view 内の anchor（bookmark 等）は
// link mark を持たないので対象外（openHref 側の listener が開く）。
export function linkClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClick(view, pos, event) {
        if (event.button !== 0 || event.shiftKey || event.altKey) return false;
        const href = linkHrefAt(view.state.doc, pos);
        if (!href) return false;
        openExternal(href);
        return true;
      },
    },
  });
}
