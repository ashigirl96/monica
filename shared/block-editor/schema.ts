import { Schema } from "@milkdown/kit/prose/model";
import type { Node as PMNode, NodeType } from "@milkdown/kit/prose/model";

export function newBlockId(): string {
  return crypto.randomUUID();
}

/** null 値を落として data 属性オブジェクトにする（toDOM の条件付き属性用） */
function dataAttrs(attrs: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attrs).filter((entry): entry is [string, string] => entry[1] !== null),
  );
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

    // URL のカード表現。メタデータはペースト時のスナップショットを属性に保持する
    bookmark: {
      group: "blockContent",
      atom: true,
      selectable: true,
      attrs: {
        href: {},
        title: { default: null },
        description: { default: null },
        thumbnail: { default: null },
        favicon: { default: null },
        siteName: { default: null },
      },
      parseDOM: [
        {
          tag: "div[data-block-content='bookmark']",
          getAttrs: (dom: HTMLElement) => ({
            href: dom.dataset.href ?? "",
            title: dom.dataset.title ?? null,
            description: dom.dataset.description ?? null,
            thumbnail: dom.dataset.thumbnail ?? null,
            favicon: dom.dataset.favicon ?? null,
            siteName: dom.dataset.siteName ?? null,
          }),
        },
      ],
      toDOM: (node) => [
        "div",
        {
          "data-block-content": "bookmark",
          "data-href": node.attrs.href as string,
          ...dataAttrs({
            "data-title": node.attrs.title as string | null,
            "data-description": node.attrs.description as string | null,
            "data-thumbnail": node.attrs.thumbnail as string | null,
            "data-favicon": node.attrs.favicon as string | null,
            "data-site-name": node.attrs.siteName as string | null,
          }),
        },
        ["a", { href: node.attrs.href as string }, (node.attrs.title as string) || ""],
      ],
    },

    text: { group: "inline" },

    // URL のインラインチップ表現（favicon + タイトル）
    linkMention: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        href: {},
        title: { default: "" },
        favicon: { default: null },
      },
      parseDOM: [
        {
          tag: "a[data-mention]",
          getAttrs: (dom: HTMLElement) => ({
            href: dom.getAttribute("href") ?? "",
            title: dom.dataset.title ?? dom.textContent ?? "",
            favicon: dom.dataset.favicon ?? null,
          }),
        },
      ],
      toDOM: (node) => [
        "a",
        {
          href: node.attrs.href as string,
          "data-mention": "",
          "data-title": node.attrs.title as string,
          ...dataAttrs({ "data-favicon": node.attrs.favicon as string | null }),
        },
        node.attrs.title as string,
      ],
    },

    // ノート間リンク（wiki link）のインラインチップ。表示名を attrs に持たず、
    // NodeView が noteId から表示時に解決する（元ノートの改題に追従させるため）。
    // parseDOM がないと HTML 経由の copy→paste で link mark の a[href] に食われて
    // プレーンテキストに退化する。
    noteMention: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: { noteId: {} },
      parseDOM: [
        {
          tag: "a[data-note-mention]",
          getAttrs: (dom: HTMLElement) => ({ noteId: dom.dataset.noteMention ?? "" }),
        },
      ],
      toDOM: (node) => [
        "a",
        {
          href: `/notes/${node.attrs.noteId as string}`,
          "data-note-mention": node.attrs.noteId as string,
        },
        node.attrs.noteId as string,
      ],
    },

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

// カーソルを置けない atom block（divider / bookmark）。indent や drop でこの下に
// 子 block を入れると操作不能になるため、受け側ガードはこの述語で判定する
export function isAtomBlock(type: NodeType): boolean {
  return type.spec.group === "blockContent" && type.spec.atom === true;
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
