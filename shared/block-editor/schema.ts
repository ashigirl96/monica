import { Schema } from "@milkdown/kit/prose/model";
import type { Node as PMNode, NodeType } from "@milkdown/kit/prose/model";

export function newBlockId(): string {
  return crypto.randomUUID();
}

/** noteMention のリンク先 URL。href の組み立てはここ 1 箇所（分解は internalNoteId） */
export function noteHref(noteId: string): string {
  return `/notes/${noteId}`;
}

/** null 値を落として data 属性オブジェクトにする（toDOM の条件付き属性用） */
function dataAttrs(attrs: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attrs).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

/** asset 配信 URL の prefix。backend の ASSET_URL_PREFIX と一致させる（文字列一致で共有）。 */
export const ASSET_URL_PREFIX = "/api/assets/";

/** 絶対 http(s) URL か。blob:/data:/file:/javascript: などは false。 */
export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** image node の src / img[src] paste で受け入れる URL を正規化する。自前 asset URL と
    外部 http(s) のみ許可し、blob:/data:/file: 等は拒否（null）。doc に blob: を入れない防波堤。 */
export function acceptedPastedImageSrc(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith(ASSET_URL_PREFIX)) return raw;
  return isHttpUrl(raw) ? raw : null;
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

    // 別ノート（または同ノート）のブロック群への参照（synced block / transclusion）。
    // Notion 同様、選択範囲全体を 1 つの synced block にまとめる（blockIds は選択順）。
    // 内容は attrs に持たず、NodeView が (noteId, blockIds) から表示時に解決する。
    // data-block-id は blockContainer 用に予約済みのため data-ref-block-ids で分ける。
    syncedBlock: {
      group: "blockContent",
      atom: true,
      selectable: true,
      attrs: { noteId: {}, blockIds: {} },
      parseDOM: [
        {
          tag: "div[data-block-content='syncedBlock']",
          getAttrs: (dom: HTMLElement) => ({
            noteId: dom.dataset.noteId ?? "",
            blockIds: (dom.dataset.refBlockIds ?? "").split(",").filter(Boolean),
          }),
        },
      ],
      toDOM: (node) => [
        "div",
        {
          "data-block-content": "syncedBlock",
          "data-note-id": node.attrs.noteId as string,
          "data-ref-block-ids": (node.attrs.blockIds as string[]).join(","),
        },
      ],
    },

    // 画像ブロック。atom leaf なので NodeView が描画を全面的に握る。src は確定 URL のみを
    // 持ち（/api/assets/... か外部 http(s)）、アップロード中は src=null + uploadId で、blob: URL は
    // doc に決して入れない（autosave が blob: を永続化して壊れるのを構造的に防ぐ）。
    image: {
      group: "blockContent",
      atom: true,
      selectable: true,
      attrs: {
        src: { default: null },
        uploadId: { default: null },
        width: { default: null },
      },
      parseDOM: [
        {
          tag: "div[data-block-content='image']",
          getAttrs: (dom: HTMLElement) => ({
            src: acceptedPastedImageSrc(dom.dataset.src ?? null),
            uploadId: null,
            width: dom.dataset.width ? Number(dom.dataset.width) : null,
          }),
        },
        {
          // 外部 HTML paste の <img> 取り込み口。blob:/data:/file: は弾く（null → ルール不成立）。
          tag: "img[src]",
          getAttrs: (dom: HTMLElement) => {
            const src = acceptedPastedImageSrc(dom.getAttribute("src"));
            return src === null ? false : { src, uploadId: null, width: null };
          },
        },
      ],
      toDOM: (node) => [
        "div",
        {
          "data-block-content": "image",
          ...dataAttrs({
            "data-src": node.attrs.src as string | null,
            "data-width": node.attrs.width !== null ? String(node.attrs.width) : null,
          }),
        },
        ...(node.attrs.src ? [["img", { src: node.attrs.src as string }]] : []),
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
          href: noteHref(node.attrs.noteId as string),
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
