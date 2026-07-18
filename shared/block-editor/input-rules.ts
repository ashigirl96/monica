import { InputRule, inputRules } from "@milkdown/kit/prose/inputrules";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Plugin, Transaction } from "@milkdown/kit/prose/state";
import type { Attrs, MarkType, NodeType } from "@milkdown/kit/prose/model";
import { nodes, schema } from "./schema";
import { getBlockContext } from "./context";
import { appendEmptyParagraphAfter, inlineToPlainText } from "./commands";

// 行頭 trigger でブロック型変換（TODO.md §6.1/§6.2）。
// blockContent の型だけ差し替え、blockContainer の ID・children は維持する。
function blockRule(
  regexp: RegExp,
  resolve: (match: RegExpMatchArray) => { type: NodeType; attrs: Attrs | null } | null,
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const ctx = getBlockContext($start);
    if (!ctx) return null;
    const content = ctx.contentNode;
    if (content.type === nodes.codeBlock) return null;
    // trigger より前に通常文字がない = マッチが content 先頭から始まる（§6.3）
    if (start !== ctx.contentPos + 1) return null;
    const target = resolve(match);
    if (!target) return null;
    if (target.type === content.type) {
      const changed = Object.entries(target.attrs ?? {}).some(
        ([key, value]) => content.attrs[key] !== value,
      );
      if (!changed) return null;
    }
    const tr = state.tr.delete(start, end);
    const mappedCtx = getBlockContext(tr.doc.resolve(start));
    if (!mappedCtx) return null;
    const result = setContentTypeOn(tr, mappedCtx.contentPos, target);
    if (!result) return null;
    // replaceWith は範囲内の position を潰すため、カーソルが後続 block の先頭へ
    // 飛ぶ（TextSelection.near の前方探索）。変換後 content の先頭へ張り直す。
    const converted = result.doc.nodeAt(mappedCtx.contentPos);
    if (converted?.inlineContent) {
      result.setSelection(TextSelection.create(result.doc, mappedCtx.contentPos + 1));
    } else if (converted?.type === nodes.divider) {
      // divider はカーソルを持てないので、Notion 同様に直後へ空 paragraph を作って移る
      appendEmptyParagraphAfter(result, mappedCtx.containerPos);
    }
    return result;
  });
}

function setContentTypeOn(
  tr: Transaction,
  contentPos: number,
  target: { type: NodeType; attrs: Attrs | null },
): Transaction | null {
  const content = tr.doc.nodeAt(contentPos);
  if (!content) return null;
  const newContent =
    target.type === nodes.divider
      ? target.type.create()
      : target.type === nodes.codeBlock
        ? // codeBlock は marks 不可・text* のみなので inline を平文化する
          target.type.create(target.attrs, inlineToPlainText(content))
        : target.type.create(target.attrs, content.content);
  return tr.replaceWith(contentPos, contentPos + content.nodeSize, newContent);
}

// inline mark rule（TODO.md §6.4）
function markRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type === nodes.codeBlock) return null;
    const text = match[1];
    if (!text) return null;
    const tr = state.tr.replaceWith(start, end, schema.text(text, [markType.create()]));
    tr.removeStoredMark(markType);
    return tr;
  });
}

const ROMAN = /^(?:i{1,3}|iv|v|vi{0,3}|ix|x)$/;

export function editorInputRuleList(): InputRule[] {
  return [
    // `[] ` `[ ] ` `-[] ` `- [ ] ` `* [ ] ` `+ [ ] ` などの todo alias（RULE-002/008/009）
    blockRule(/^(?:[-*+] ?)?\[([ x]?)\] $/, (match) => ({
      type: nodes.todo,
      attrs: { checked: match[1] === "x" },
    })),
    // `- ` `* ` `+ ` → bullet（RULE-001）
    blockRule(/^([-*+]) $/, () => ({ type: nodes.bullet, attrs: null })),
    // `1. ` `a. ` `i. ` → numbered（RULE-003）。roman を alpha より先に判定する
    blockRule(/^(\d{1,3}|[a-z]{1,4})\. $/, (match) => {
      const marker = match[1];
      if (/^\d+$/.test(marker)) return { type: nodes.numbered, attrs: { style: "decimal" } };
      if (ROMAN.test(marker)) return { type: nodes.numbered, attrs: { style: "lower-roman" } };
      if (marker.length === 1) return { type: nodes.numbered, attrs: { style: "lower-alpha" } };
      return null;
    }),
    // `## ` `### ` → heading（RULE-004）。H1 は使わないため `# ` は発火しない
    blockRule(/^(#{2,3}) $/, (match) => ({
      type: nodes.heading,
      attrs: { level: match[1].length },
    })),
    // `> ` → toggle（RULE-005）
    blockRule(/^> $/, () => ({ type: nodes.toggle, attrs: { open: true } })),
    // `" ` → quote（RULE-006）
    blockRule(/^" $/, () => ({ type: nodes.quote, attrs: null })),
    // `---` → divider（RULE-007）
    blockRule(/^---$/, () => ({ type: nodes.divider, attrs: null })),
    // ``` → code block（Notion 互換）
    blockRule(/^```$/, () => ({ type: nodes.codeBlock, attrs: null })),
    // inline marks（§6.4）
    markRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, schema.marks.bold),
    markRule(/(?<!\*)\*([^*\s](?:[^*]*[^*\s])?)\*$/, schema.marks.italic),
    markRule(/`([^`\s](?:[^`]*[^`\s])?)`$/, schema.marks.code),
    markRule(/~([^~\s](?:[^~]*[^~\s])?)~$/, schema.marks.strike),
  ];
}

export function editorInputRules(): Plugin {
  return inputRules({ rules: editorInputRuleList() });
}
