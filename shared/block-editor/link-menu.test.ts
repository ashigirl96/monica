/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, schema } from "./schema";
import { previewTransaction } from "./link-menu";
import type { LinkMenuActiveState, LinkMetadata } from "./link-menu";

const URL = "https://example.com/x";

const META: LinkMetadata = {
  title: "Example Title",
  description: "desc",
  image: "https://example.com/og.png",
  favicon: "https://example.com/favicon.ico",
  siteName: "Example",
};

function linkText(url: string): PMNode {
  return schema.text(url, [schema.marks.link.create({ href: url })]);
}

/** paste 直後（プレーンリンク挿入済み）の doc。from は URL テキスト先頭 */
function pastedDoc(before = "", after = ""): { doc: PMNode; from: number } {
  const inline = [
    ...(before ? [schema.text(before)] : []),
    linkText(URL),
    ...(after ? [schema.text(after)] : []),
  ];
  const doc = nodes.doc.create(
    null,
    nodes.blockGroup.create(null, createContainer(nodes.paragraph.create(null, inline), [], "a")),
  );
  return { doc, from: 3 + before.length };
}

function openedState(
  doc: PMNode,
  from: number,
  meta: LinkMetadata | null = null,
): { state: EditorState; s: LinkMenuActiveState } {
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from + URL.length),
  });
  return {
    state,
    s: {
      active: true,
      from,
      url: URL,
      index: 0,
      preview: "url",
      caret: from + URL.length,
      bookmarkPos: null,
      extraParaPos: null,
      meta,
      metaDone: meta !== null,
      confirmPending: false,
    },
  };
}

function apply(
  state: EditorState,
  s: LinkMenuActiveState,
  target: Parameters<typeof previewTransaction>[2],
): { state: EditorState; s: LinkMenuActiveState } {
  const res = previewTransaction(state, s, target);
  expect(res).not.toBeNull();
  if (!res) throw new Error("unreachable");
  return { state: state.apply(res.tr), s: res.next };
}

describe("previewTransaction", () => {
  test("url → mention: URL テキストが inline mention に置き換わる", () => {
    const { doc, from } = pastedDoc();
    const opened = openedState(doc, from);
    const { state, s } = apply(opened.state, opened.s, "mention");

    const para = state.doc.child(0).child(0).child(0);
    expect(para.type).toBe(nodes.paragraph);
    expect(para.childCount).toBe(1);
    expect(para.child(0).type).toBe(nodes.linkMention);
    // metadata 未取得 → URL が placeholder タイトル
    expect(para.child(0).attrs.title).toBe(URL);
    expect(s.caret).toBe(from + 1);
    expect(state.selection.head).toBe(s.caret);
  });

  test("mention → url: 元のプレーンリンクに完全復元される", () => {
    const { doc, from } = pastedDoc();
    const opened = openedState(doc, from);
    const step1 = apply(opened.state, opened.s, "mention");
    const step2 = apply(step1.state, step1.s, "url");

    expect(step2.state.doc.eq(doc)).toBe(true);
    expect(step2.state.selection.head).toBe(from + URL.length);
  });

  test("url → bookmark（URL 単独段落）: 段落ごと bookmark 化し空段落を後ろに足す", () => {
    const { doc, from } = pastedDoc();
    const opened = openedState(doc, from);
    const { state, s } = apply(opened.state, opened.s, "bookmark");

    const group = state.doc.child(0);
    expect(group.childCount).toBe(2);
    expect(group.child(0).child(0).type).toBe(nodes.bookmark);
    expect(group.child(0).child(0).attrs.href).toBe(URL);
    expect(group.child(1).child(0).type).toBe(nodes.paragraph);
    expect(s.bookmarkPos).toBe(from - 1);
    expect(state.doc.nodeAt(s.bookmarkPos ?? -1)?.type).toBe(nodes.bookmark);
    // カーソルは追加した空段落の中
    expect(state.selection.head).toBe(s.caret);
    expect(state.selection.$head.parent.type).toBe(nodes.paragraph);
  });

  test("bookmark（URL 単独段落）→ url: 追加段落ごと消えて完全復元される", () => {
    const { doc, from } = pastedDoc();
    const opened = openedState(doc, from);
    const step1 = apply(opened.state, opened.s, "bookmark");
    const step2 = apply(step1.state, step1.s, "url");

    expect(step2.state.doc.eq(doc)).toBe(true);
  });

  test("url → bookmark（前後テキストあり）: URL テキストを消して直後に block 挿入", () => {
    const { doc, from } = pastedDoc("before ", " after");
    const opened = openedState(doc, from);
    const { state, s } = apply(opened.state, opened.s, "bookmark");

    const group = state.doc.child(0);
    expect(group.childCount).toBe(2);
    expect(group.child(0).child(0).textContent).toBe("before  after");
    expect(group.child(1).child(0).type).toBe(nodes.bookmark);
    expect(state.doc.nodeAt(s.bookmarkPos ?? -1)?.type).toBe(nodes.bookmark);
    expect(s.extraParaPos).toBeNull();
    expect(state.selection.head).toBe(from);
  });

  test("bookmark（前後テキストあり）→ mention: 直接遷移でも URL 経由で組み替わる", () => {
    const { doc, from } = pastedDoc("before ", " after");
    const opened = openedState(doc, from);
    const step1 = apply(opened.state, opened.s, "bookmark");
    const step2 = apply(step1.state, step1.s, "mention");

    const group = step2.state.doc.child(0);
    expect(group.childCount).toBe(1);
    const para = group.child(0).child(0);
    expect(para.childCount).toBe(3);
    expect(para.child(0).text).toBe("before ");
    expect(para.child(1).type).toBe(nodes.linkMention);
    expect(para.child(2).text).toBe(" after");
  });

  test("metadata 取得済みなら preview node に attrs が反映される", () => {
    const { doc, from } = pastedDoc();
    const opened = openedState(doc, from, META);
    const mention = apply(opened.state, opened.s, "mention");
    const para = mention.state.doc.child(0).child(0).child(0);
    expect(para.child(0).attrs.title).toBe("Example Title");
    expect(para.child(0).attrs.favicon).toBe(META.favicon);

    const bookmark = apply(mention.state, mention.s, "bookmark");
    const node = bookmark.state.doc.nodeAt(bookmark.s.bookmarkPos ?? -1);
    expect(node?.attrs.title).toBe("Example Title");
    expect(node?.attrs.thumbnail).toBe(META.image);
    expect(node?.attrs.siteName).toBe("Example");
  });

  test("URL 単独の bullet は段落置換ではなく直後挿入になる", () => {
    const doc = nodes.doc.create(
      null,
      nodes.blockGroup.create(
        null,
        createContainer(nodes.bullet.create(null, linkText(URL)), [], "a"),
      ),
    );
    const from = 3;
    const opened = openedState(doc, from);
    const { state, s } = apply(opened.state, opened.s, "bookmark");

    const group = state.doc.child(0);
    expect(group.childCount).toBe(2);
    expect(group.child(0).child(0).type).toBe(nodes.bullet);
    expect(group.child(1).child(0).type).toBe(nodes.bookmark);
    expect(s.extraParaPos).toBeNull();
  });
});
