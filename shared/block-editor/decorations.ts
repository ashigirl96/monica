import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { nodes } from "./schema";
import { codeExitPos } from "./commands";
import { foldedIndexes } from "./folding";
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

function codeExitCaretDOM(): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "jb-code-exit-caret";
  return caret;
}

// exitInlineCode（行末の → で inline code から降りる）の直後、native キャレットは
// <code> 内の DOM 位置に描かれたままで「抜けた」ことが見えない。code の外に fake caret を
// 立て、native 側は CSS（.jb-editor:has(.jb-code-exit-caret)）が隠す。
// marks: [] が必須 — 省略すると widget が code mark に包まれて chip の内側に描かれる。
// key は widget の同一性判定用 — 無いと表示中の全 transaction で span が作り直され、
// blink アニメーションもそのたび先頭に戻る。
export function codeExitCaretPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("journalCodeExitCaret"),
    props: {
      decorations(state) {
        const pos = codeExitPos(state);
        if (pos === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(pos, codeExitCaretDOM, { side: 1, marks: [], key: "code-exit-caret" }),
        ]);
      },
    },
  });
}

// contenteditable は editor 全体で 1 つなので、「カーソルがこの code block 内にある」は
// :focus-within では取れない。selection から導出した class で toolbar 分の上余白
// （CSS の .jb-code-active）を確保する。
export function codeBlockActivePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("journalCodeBlockActive"),
    props: {
      decorations(state) {
        const $from = state.selection.$from;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type !== nodes.codeBlock) continue;
          const pos = $from.before(depth);
          return DecorationSet.create(state.doc, [
            Decoration.node(pos, pos + node.nodeSize, { class: "jb-code-active" }),
          ]);
        }
        return null;
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

// doc 由来の block decoration をまとめて 1 回の walk で作る。打鍵ごとに再構築される
// ので、種類ごとに plugin を分けると全文走査がそのぶん増える。
//
// - 表示番号（TODO.md §11.3）は同一 group 内の連続 numbered 兄弟から導出し、文書には
//   保存しない。非 numbered block・style 変更で reset、nested group は独立。
// - heading は doc 上の子を持たないため、折りたたみ範囲（後続兄弟）を `.jb-collapsed`
//   の CSS では隠せない。範囲は内容から導出されるのでここで class を付ける。
function buildBlockDecorations(doc: PMNode): Decoration[] {
  const decorations: Decoration[] = [];
  const walkGroup = (group: PMNode, groupPos: number) => {
    const hidden = foldedIndexes(group);
    let run = 0;
    let runStyle: string | null = null;
    group.forEach((container, offset, index) => {
      const containerPos = groupPos + 1 + offset;
      const content = container.child(0);
      if (hidden.has(index)) {
        decorations.push(
          Decoration.node(containerPos, containerPos + container.nodeSize, {
            class: "jb-fold-hidden",
          }),
        );
      }
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

export function blockDecorationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: new PluginKey("journalBlockDecorations"),
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, buildBlockDecorations(state.doc)),
      apply(tr, value) {
        // collapsed / style は attr なので、開閉や種別変更も docChanged として届く
        if (!tr.docChanged) return value;
        return DecorationSet.create(tr.doc, buildBlockDecorations(tr.doc));
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
