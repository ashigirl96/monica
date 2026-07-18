/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, schema } from "./schema";
import { insertNoteMentionTransaction, internalNoteId } from "./note-mention-menu";

const ORIGIN = "http://localhost:19281";

describe("internalNoteId", () => {
  test("相対 path から id セグメントを抜き出す", () => {
    expect(internalNoteId("/notes/note-3", ORIGIN)).toBe("note-3");
    expect(internalNoteId("/notes/note-3/", ORIGIN)).toBe("note-3");
    expect(internalNoteId("  /notes/note-3  ", ORIGIN)).toBe("note-3");
  });

  test("origin 一致の絶対 URL は通り、不一致は null", () => {
    expect(internalNoteId(`${ORIGIN}/notes/note-42`, ORIGIN)).toBe("note-42");
    expect(internalNoteId("https://example.com/notes/note-42", ORIGIN)).toBeNull();
  });

  test("クエリ・fragment は無視して path だけ見る", () => {
    expect(internalNoteId(`${ORIGIN}/notes/note-1?x=1`, ORIGIN)).toBe("note-1");
    expect(internalNoteId("/notes/note-1#top", ORIGIN)).toBe("note-1");
  });

  test("/notes 以外・segment なし・空白混じりは null", () => {
    expect(internalNoteId("/explanations/e-1", ORIGIN)).toBeNull();
    expect(internalNoteId("/notes", ORIGIN)).toBeNull();
    expect(internalNoteId("/notes/", ORIGIN)).toBeNull();
    expect(internalNoteId("/notes/a/b", ORIGIN)).toBeNull();
    expect(internalNoteId("", ORIGIN)).toBeNull();
    expect(internalNoteId("note 3", ORIGIN)).toBeNull();
    expect(internalNoteId("not-a-url", ORIGIN)).toBeNull();
  });

  test("id の正規形は検証しない（妥当性は resolve の 404 に委ねる）", () => {
    expect(internalNoteId("/notes/anything", ORIGIN)).toBe("anything");
  });
});

/** `[[query` 入力済みの doc。pos は最初の `[` の位置、カーソルは query 末尾（after はその後ろ） */
function typedDoc(query: string, before = "", after = ""): { state: EditorState; pos: number } {
  const text = `${before}[[${query}${after}`;
  const doc: PMNode = nodes.doc.create(
    null,
    nodes.blockGroup.create(
      null,
      createContainer(nodes.paragraph.create(null, schema.text(text)), [], "a"),
    ),
  );
  const pos = 3 + before.length;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos + 2 + query.length),
  });
  return { state, pos };
}

function firstParagraph(state: EditorState): PMNode {
  return state.doc.firstChild!.firstChild!.firstChild!;
}

describe("insertNoteMentionTransaction", () => {
  test("[[query を削除して noteMention を挿入し、カーソルを直後に置く", () => {
    const { state, pos } = typedDoc("zettel", "see ");
    const tr = insertNoteMentionTransaction(state, { pos }, "note-7");
    const next = state.apply(tr);

    const para = firstParagraph(next);
    expect(para.childCount).toBe(2);
    expect(para.child(0).text).toBe("see ");
    expect(para.child(1).type).toBe(nodes.noteMention);
    expect(para.child(1).attrs.noteId).toBe("note-7");
    expect(next.selection.head).toBe(pos + para.child(1).nodeSize);
  });

  test("空 query（[[ のみ）でも動く", () => {
    const { state, pos } = typedDoc("");
    const tr = insertNoteMentionTransaction(state, { pos }, "note-1");
    const next = state.apply(tr);

    const para = firstParagraph(next);
    expect(para.childCount).toBe(1);
    expect(para.child(0).type).toBe(nodes.noteMention);
    expect(para.child(0).attrs.noteId).toBe("note-1");
  });

  test("mention の後ろのテキストは保持される", () => {
    // カーソルが query 末尾・後続テキストありの状態（paste 直後など）
    const { state, pos } = typedDoc("/notes/note-9", "", " tail");
    const tr = insertNoteMentionTransaction(state, { pos }, "note-9");
    const next = state.apply(tr);

    const para = firstParagraph(next);
    expect(para.child(0).type).toBe(nodes.noteMention);
    expect(para.child(1).text).toBe(" tail");
  });
});
