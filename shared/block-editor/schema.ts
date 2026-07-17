import { Schema } from "@milkdown/kit/prose/model";
import type { Node as PMNode, NodeType } from "@milkdown/kit/prose/model";

export function newBlockId(): string {
  return crypto.randomUUID();
}

// TODO.md §0: ID付きの任意ネスト可能なブロックツリーを正とする。
// doc → blockGroup → blockContainer(id) → blockContent + blockGroup?
export const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },

    blockGroup: {
      content: "blockContainer+",
      parseDOM: [{ tag: "div[data-block-group]" }],
      toDOM: () => ["div", { "data-block-group": "" }, 0],
    },

    blockContainer: {
      content: "blockContent blockGroup?",
      attrs: { id: { default: null } },
      defining: true,
      parseDOM: [
        {
          tag: "div[data-block-container]",
          getAttrs: (dom: HTMLElement) => ({ id: dom.dataset.blockId ?? null }),
        },
      ],
      toDOM: (node) => [
        "div",
        {
          "data-block-container": "",
          ...(node.attrs.id ? { "data-block-id": node.attrs.id as string } : {}),
        },
        0,
      ],
    },

    // paragraph を blockContent 群の先頭に置く: content expression の穴埋めで
    // ProseMirror が合成するデフォルト型になる。
    paragraph: {
      group: "blockContent",
      content: "inline*",
      parseDOM: [{ tag: "p" }, { tag: "div[data-block-content='paragraph']" }],
      toDOM: () => ["div", { "data-block-content": "paragraph" }, 0],
    },

    heading: {
      group: "blockContent",
      content: "inline*",
      attrs: { level: { default: 1 } },
      parseDOM: [
        ...[1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })),
        {
          tag: "div[data-block-content='heading']",
          getAttrs: (dom: HTMLElement) => ({ level: Number(dom.dataset.level) || 1 }),
        },
      ],
      toDOM: (node) => [
        "div",
        { "data-block-content": "heading", "data-level": String(node.attrs.level) },
        0,
      ],
    },

    todo: {
      group: "blockContent",
      content: "inline*",
      attrs: { checked: { default: false } },
      parseDOM: [
        {
          tag: "div[data-block-content='todo']",
          getAttrs: (dom: HTMLElement) => ({ checked: dom.dataset.checked === "true" }),
        },
      ],
      toDOM: (node) => [
        "div",
        { "data-block-content": "todo", "data-checked": String(node.attrs.checked) },
        0,
      ],
    },

    bullet: {
      group: "blockContent",
      content: "inline*",
      parseDOM: [{ tag: "div[data-block-content='bullet']" }],
      toDOM: () => ["div", { "data-block-content": "bullet" }, 0],
    },

    numbered: {
      group: "blockContent",
      content: "inline*",
      attrs: { style: { default: "decimal" } },
      parseDOM: [
        {
          tag: "div[data-block-content='numbered']",
          getAttrs: (dom: HTMLElement) => ({ style: dom.dataset.style ?? "decimal" }),
        },
      ],
      toDOM: (node) => [
        "div",
        { "data-block-content": "numbered", "data-style": node.attrs.style as string },
        0,
      ],
    },

    toggle: {
      group: "blockContent",
      content: "inline*",
      attrs: { open: { default: true } },
      parseDOM: [
        {
          tag: "div[data-block-content='toggle']",
          getAttrs: (dom: HTMLElement) => ({ open: dom.dataset.open !== "false" }),
        },
      ],
      toDOM: (node) => [
        "div",
        { "data-block-content": "toggle", "data-open": String(node.attrs.open) },
        0,
      ],
    },

    quote: {
      group: "blockContent",
      content: "inline*",
      parseDOM: [{ tag: "blockquote" }, { tag: "div[data-block-content='quote']" }],
      toDOM: () => ["div", { "data-block-content": "quote" }, 0],
    },

    callout: {
      group: "blockContent",
      content: "inline*",
      attrs: { kind: { default: "note" } },
      parseDOM: [
        {
          tag: "div[data-block-content='callout']",
          getAttrs: (dom: HTMLElement) => ({ kind: dom.dataset.kind ?? "note" }),
        },
      ],
      toDOM: (node) => [
        "div",
        { "data-block-content": "callout", "data-kind": node.attrs.kind as string },
        0,
      ],
    },

    codeBlock: {
      group: "blockContent",
      content: "text*",
      marks: "",
      code: true,
      attrs: {
        language: { default: "plain text" },
        wrap: { default: false },
      },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (node) => [
        "pre",
        { "data-block-content": "codeBlock", "data-language": node.attrs.language as string },
        ["code", 0],
      ],
    },

    divider: {
      group: "blockContent",
      atom: true,
      selectable: false,
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["div", { "data-block-content": "divider" }, ["hr"]],
    },

    text: { group: "inline" },

    hardBreak: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },

  marks: {
    bold: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }],
      toDOM: () => ["strong", 0],
    },
    italic: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: () => ["s", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute("href") }),
        },
      ],
      toDOM: (mark) => ["a", { href: mark.attrs.href as string }, 0],
    },
  },
});

export const nodes = schema.nodes;

// blockContent のうち inline content を持つ型（= テキスト編集・merge 可能な型）
export function isTextBlock(type: NodeType): boolean {
  return type.spec.group === "blockContent" && type.inlineContent;
}

export function isListLike(type: NodeType): boolean {
  return type === nodes.todo || type === nodes.bullet || type === nodes.numbered;
}

export function createContainer(
  content: PMNode,
  children?: readonly PMNode[],
  id: string = newBlockId(),
): PMNode {
  const groupChildren =
    children && children.length > 0 ? [nodes.blockGroup.create(null, [...children])] : [];
  return nodes.blockContainer.create({ id }, [content, ...groupChildren]);
}

export function emptyParagraphContainer(): PMNode {
  return createContainer(nodes.paragraph.create());
}

export function emptyDoc(): PMNode {
  return nodes.doc.create(null, nodes.blockGroup.create(null, emptyParagraphContainer()));
}

// paste / duplicate / copy-drag で subtree の全 ID を再発行する（TODO.md §1.5）
export function reissueIds(node: PMNode): PMNode {
  if (node.type === nodes.blockContainer) {
    return node.type.create(
      { ...node.attrs, id: newBlockId() },
      node.content.content.map(reissueIds),
      node.marks,
    );
  }
  if (node.type === nodes.blockGroup) {
    return node.type.create(node.attrs, node.content.content.map(reissueIds), node.marks);
  }
  return node;
}
