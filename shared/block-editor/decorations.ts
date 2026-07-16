import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { nodes } from "./schema";
import { getBlockContext } from "./context";
import { blockSelectionKey } from "./selection-state";

// TODO.md §9.2: placeholder 文字列は文書に入れず Decoration で描く。
export function placeholderPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("journalPlaceholder"),
    props: {
      decorations(state) {
        const sel = state.selection;
        if (!sel.empty) return null;
        const blockSel = blockSelectionKey.getState(state);
        if (blockSel && blockSel.selectedIds.length > 0) return null;
        const ctx = getBlockContext(sel.$from);
        if (!ctx) return null;
        if (ctx.contentNode.type !== nodes.paragraph && ctx.contentNode.type !== nodes.callout)
          return null;
        if (ctx.contentNode.content.size > 0) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(ctx.contentPos, ctx.contentPos + ctx.contentNode.nodeSize, {
            class: "jb-placeholder",
            "data-placeholder": "Write, or press '/' for commands",
          }),
        ]);
      },
    },
  });
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let rest = n;
  let out = "";
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

function markerLabel(style: string, index: number): string {
  if (style === "lower-alpha") {
    let n = index;
    let out = "";
    do {
      out = String.fromCharCode(97 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `${out}.`;
  }
  if (style === "lower-roman") return `${toRoman(index + 1)}.`;
  return `${index + 1}.`;
}

// TODO.md §11.3: 表示番号は同一 group 内の連続 numbered 兄弟から導出し、
// 文書には保存しない。非 numbered block・style 変更で reset、nested group は独立。
function buildNumbering(doc: PMNode): Decoration[] {
  const decorations: Decoration[] = [];
  const walkGroup = (group: PMNode, groupPos: number) => {
    let run = 0;
    let runStyle: string | null = null;
    group.forEach((container, offset) => {
      const containerPos = groupPos + 1 + offset;
      const content = container.child(0);
      if (content.type === nodes.numbered) {
        const style = content.attrs.style as string;
        if (style !== runStyle) {
          run = 0;
          runStyle = style;
        }
        decorations.push(
          Decoration.node(containerPos + 1, containerPos + 1 + content.nodeSize, {
            "data-marker": markerLabel(style, run),
          }),
        );
        run++;
      } else {
        run = 0;
        runStyle = null;
      }
      if (container.childCount > 1) {
        walkGroup(container.child(1), containerPos + 1 + content.nodeSize);
      }
    });
  };
  walkGroup(doc.child(0), 0);
  return decorations;
}

export function numberingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: new PluginKey("journalNumbering"),
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, buildNumbering(state.doc)),
      apply(tr, value) {
        if (!tr.docChanged) return value;
        return DecorationSet.create(tr.doc, buildNumbering(tr.doc));
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
